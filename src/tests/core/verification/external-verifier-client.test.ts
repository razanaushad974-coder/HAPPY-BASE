import assert from "node:assert/strict";
import { generateKeyPairSync, createSign } from "node:crypto";
import { HttpExternalSemanticVerifierClient } from "../../../core/verification/external-verifier-client";
import type { Evidence } from "../../../core/evidence/types";
import type { VerificationRequest } from "../../../core/verification/types";
import { AsyncEvidenceService } from "../../../core/evidence/async-service";
import { InMemoryTenantPersistenceAdapter } from "../../../core/persistence/adapters/in-memory-tenant-adapter";
import { createAsyncHappyStateStore } from "../../../core/state/async-factory";
import { AsyncVerificationService } from "../../../core/verification/async-service";
import { canonicalSemanticAttestationPayload, TrustedSemanticAttestationAuthority, type SemanticAttestationPayload } from "../../../core/verification/semantic-attestation";

const scope = { organizationId: "org-1", workspaceId: "workspace-1", userId: "user-1" };
const request: VerificationRequest = {
  id: "verification-1",
  missionId: "mission-1",
  taskId: "task-1",
  executionRequestId: "execution-1",
  description: "Check the task result",
  criteria: [{ id: "criterion-1", description: "Output exists", expected: "present", required: true }],
  preferredMethods: ["TEST"],
  requiresEvidence: true,
  createdAt: new Date().toISOString(),
};
const evidence: Evidence = {
  id: "evidence-1",
  verificationRequestId: request.id,
  executionRequestId: request.executionRequestId,
  missionId: request.missionId,
  taskId: request.taskId,
  type: "TEST_RESULT",
  source: "TEST",
  title: "Test output",
  content: "The expected output exists.",
  uri: "https://storage.example.test/private?token=must-not-leak",
  metadata: { apiKey: "must-not-leak" },
  capturedAt: new Date().toISOString(),
  isPrimary: true,
};

async function main(): Promise<void> {
  let requestBody: Record<string, unknown> | undefined;
  let requestHeaders: Headers | undefined;
  let tokenReads = 0;
  const client = new HttpExternalSemanticVerifierClient({
    endpoint: "https://verifier.example.test/v1/evaluate",
    readBearerToken: async () => { tokenReads += 1; return "server-side-token"; },
    fetchImpl: async (_input, init) => {
      requestHeaders = new Headers(init?.headers);
      requestBody = JSON.parse(String(init?.body)) as Record<string, unknown>;
      return new Response(JSON.stringify({
        payload: { schemaVersion: 1, verifierId: "verifier-1" },
        signature: "signed-envelope",
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const result = await client.evaluate({ scope, request, evidence: [evidence] });
  assert.equal(result.signature, "signed-envelope");
  assert.equal(requestHeaders?.get("authorization"), "Bearer server-side-token");
  assert.equal(requestHeaders?.get("idempotency-key"), request.id);
  assert.equal(tokenReads, 1);
  const sentEvidence = (requestBody?.evidence as Array<Record<string, unknown>>)[0];
  assert.equal(sentEvidence.id, evidence.id);
  assert.equal(sentEvidence.content, evidence.content);
  assert.equal("uri" in sentEvidence, false);
  assert.equal("metadata" in sentEvidence, false);
  assert.equal(JSON.stringify(requestBody).includes("must-not-leak"), false);

  assert.throws(
    () => new HttpExternalSemanticVerifierClient({
      endpoint: "http://verifier.example.test/evaluate",
      readBearerToken: async () => "token",
    }),
    /FIXED_HTTPS/,
  );
  assert.throws(
    () => new HttpExternalSemanticVerifierClient({
      endpoint: "https://user:password@verifier.example.test/evaluate",
      readBearerToken: async () => "token",
    }),
    /FIXED_HTTPS/,
  );
  assert.throws(
    () => new HttpExternalSemanticVerifierClient({
      endpoint: "https://verifier.example.test/evaluate?target=other",
      readBearerToken: async () => "token",
    }),
    /FIXED_HTTPS/,
  );

  await assert.rejects(
    () => client.evaluate({ scope, request, evidence: [{ ...evidence, taskId: "other-task" }] }),
    /EVIDENCE_BINDING_INVALID/,
  );
  await assert.rejects(
    () => client.evaluate({ scope, request, evidence: [{ ...evidence, content: "x".repeat(16_385) }] }),
    /EVIDENCE_TOO_LARGE/,
  );

  const badResponseClient = new HttpExternalSemanticVerifierClient({
    endpoint: "https://verifier.example.test/v1/evaluate",
    readBearerToken: async () => "server-side-token",
    fetchImpl: async () => new Response("not-json", {
      status: 200, headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(
    () => badResponseClient.evaluate({ scope, request, evidence: [evidence] }),
    /RESPONSE_INVALID_JSON/,
  );

  const oversizedResponseClient = new HttpExternalSemanticVerifierClient({
    endpoint: "https://verifier.example.test/v1/evaluate",
    readBearerToken: async () => "server-side-token",
    maxResponseBytes: 1_024,
    fetchImpl: async () => new Response("x".repeat(1_025), {
      status: 200, headers: { "content-type": "application/json" },
    }),
  });
  await assert.rejects(
    () => oversizedResponseClient.evaluate({ scope, request, evidence: [evidence] }),
    /RESPONSE_TOO_LARGE/,
  );

  let oversizedStreamCancelled = false;
  const chunkedOversizedResponseClient = new HttpExternalSemanticVerifierClient({
    endpoint: "https://verifier.example.test/v1/evaluate",
    readBearerToken: async () => "server-side-token",
    maxResponseBytes: 1_024,
    fetchImpl: async () => new Response(new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(new Uint8Array(700));
        controller.enqueue(new Uint8Array(400));
      },
      cancel() {
        oversizedStreamCancelled = true;
      },
    }), { status: 200, headers: { "content-type": "application/json" } }),
  });
  await assert.rejects(
    () => chunkedOversizedResponseClient.evaluate({ scope, request, evidence: [evidence] }),
    /RESPONSE_TOO_LARGE/,
  );
  assert.equal(oversizedStreamCancelled, true);

  // End-to-end service path: external evaluation returns a signature that
  // the trusted authority independently validates before persistence.
  const pair = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const authority = new TrustedSemanticAttestationAuthority([{
    verifierId: "external-verifier", keyId: "external-key-1", publicKeyPem: pair.publicKey,
  }]);
  const adapter = new InMemoryTenantPersistenceAdapter();
  const state = createAsyncHappyStateStore(adapter, scope.organizationId, scope.workspaceId, scope.userId);
  await state.mission().create(request.missionId, {
    id: request.missionId, taskIds: [request.taskId], status: "READY",
  });
  await state.task().create(request.taskId, {
    id: request.taskId, missionId: request.missionId, status: "READY",
  });
  const service = new AsyncVerificationService(state, authority);
  await service.registerRequest({ ...request, executionRequestId: undefined });
  const evidenceService = new AsyncEvidenceService(state);
  const registeredEvidence = await evidenceService.capture({
    verificationRequestId: request.id,
    missionId: request.missionId,
    taskId: request.taskId,
    type: "TEST_RESULT",
    source: "TEST",
    title: "External verifier evidence",
    content: "Verified output is present.",
  });
  const integratedRequest: VerificationRequest = { ...request, executionRequestId: undefined };
  const integratedClient = new HttpExternalSemanticVerifierClient({
    endpoint: "https://verifier.example.test/v1/evaluate",
    readBearerToken: async () => "integration-token",
    fetchImpl: async (_input, init) => {
      const body = JSON.parse(String(init?.body)) as {
        scope: typeof scope;
        request: VerificationRequest;
        evidence: Array<{ id: string }>;
      };
      const payload: SemanticAttestationPayload = {
        schemaVersion: 1,
        verifierId: "external-verifier",
        keyId: "external-key-1",
        organizationId: body.scope.organizationId,
        workspaceId: body.scope.workspaceId,
        userId: body.scope.userId,
        requestId: body.request.id,
        missionId: body.request.missionId,
        taskId: body.request.taskId,
        executionRequestId: null,
        evidenceIds: body.evidence.map((item) => item.id),
        passedCriteria: ["criterion-1"],
        failedCriteria: [],
        partialCriteria: [],
        outcome: "PASSED",
        confidence: "HIGH",
        summary: "External verifier confirmed the registered output.",
        verifiedAt: new Date().toISOString(),
      };
      const signer = createSign("RSA-SHA256");
      signer.update(canonicalSemanticAttestationPayload(payload));
      signer.end();
      return new Response(JSON.stringify({
        payload, signature: signer.sign(pair.privateKey, "base64"),
      }), { status: 200, headers: { "content-type": "application/json" } });
    },
  });
  const integratedResult = await service.verifyWithExternalVerifier(
    integratedRequest.id, [registeredEvidence.id], integratedClient,
  );
  assert.equal(integratedResult.status, "PASSED");
  assert.deepEqual(integratedResult.evidenceIds, [registeredEvidence.id]);
  assert.ok(integratedResult.attestation);

  console.log("External semantic verifier HTTPS client contract: PASS");
  console.log({
    fixedHttpsEndpoint: true,
    serverSideBearerAuth: true,
    tenantAndTaskBinding: true,
    sensitiveEvidenceMetadataExcluded: true,
    boundedPayloadAndResponse: true,
    malformedResponsesFailClosed: true,
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
