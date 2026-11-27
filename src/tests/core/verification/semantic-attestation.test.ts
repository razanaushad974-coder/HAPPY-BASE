import { generateKeyPairSync, createSign } from "node:crypto";
import {
  canonicalSemanticAttestationPayload,
  TrustedSemanticAttestationAuthority,
  type SemanticAttestationPayload,
  type SignedSemanticAttestation,
} from "../../../core/verification/semantic-attestation";
import type { VerificationRequest } from "../../../core/verification/types";
import { AsyncEvidenceService } from "../../../core/evidence/async-service";
import { InMemoryTenantPersistenceAdapter } from "../../../core/persistence/adapters/in-memory-tenant-adapter";
import { createAsyncHappyStateStore } from "../../../core/state/async-factory";
import { AsyncVerificationService } from "../../../core/verification/async-service";
import { ReasoningOrchestrator } from "../../../core/reasoning/orchestrator";
import { MissionOrchestrator } from "../../../core/mission/orchestrator";
import { createTrustedSemanticAttestationAuthority } from "../../../core/verification/semantic-attestation-config";

async function main(): Promise<void> {
  const { publicKey, privateKey } = generateKeyPairSync("rsa", {
    modulusLength: 2048,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  const now = Date.parse("2026-11-26T15:00:00.000Z");
  const request: VerificationRequest = {
    id: "verification-1",
    missionId: "mission-1",
    taskId: "task-1",
    executionRequestId: "execution-1",
    description: "Verify the completed task outcome",
    criteria: [
      { id: "criterion-pass", description: "Output exists", expected: "present", required: true },
      { id: "criterion-optional", description: "Optional metadata", expected: "present", required: false },
    ],
    preferredMethods: ["TEST"],
    requiresEvidence: true,
    createdAt: new Date(now - 60_000).toISOString(),
  };
  const scope = { organizationId: "org-1", workspaceId: "workspace-1", userId: "user-1" };
  const payload: SemanticAttestationPayload = {
    schemaVersion: 1,
    verifierId: "happy-semantic-verifier",
    keyId: "key-2026-01",
    organizationId: scope.organizationId,
    workspaceId: scope.workspaceId,
    userId: scope.userId,
    requestId: request.id,
    missionId: request.missionId,
    taskId: request.taskId,
    executionRequestId: request.executionRequestId ?? null,
    evidenceIds: ["evidence-1"],
    passedCriteria: ["criterion-pass"],
    failedCriteria: [],
    partialCriteria: [],
    outcome: "PASSED",
    confidence: "HIGH",
    summary: "Required task outcome verified.",
    verifiedAt: new Date(now - 30_000).toISOString(),
  };
  const sign = (value: SemanticAttestationPayload): SignedSemanticAttestation => {
    const signer = createSign("RSA-SHA256");
    signer.update(canonicalSemanticAttestationPayload(value));
    signer.end();
    return { payload: value, signature: signer.sign(privateKey, "base64") };
  };
  if (createTrustedSemanticAttestationAuthority(undefined) !== null) {
    throw new Error("Missing verifier configuration should leave semantic verification disconnected.");
  }
  const configuredAuthority = createTrustedSemanticAttestationAuthority(JSON.stringify([{
    verifierId: payload.verifierId,
    keyId: payload.keyId,
    publicKeyPem: publicKey,
  }]));
  if (!(configuredAuthority instanceof TrustedSemanticAttestationAuthority)) {
    throw new Error("Operator-provisioned verifier public key configuration was not loaded.");
  }
  let malformedConfigRejected = false;
  try {
    createTrustedSemanticAttestationAuthority(JSON.stringify([{
      verifierId: payload.verifierId,
      keyId: payload.keyId,
      publicKeyPem: publicKey,
      privateKeyPem: "must-not-be-accepted",
    }]));
  } catch (error) {
    malformedConfigRejected = error instanceof Error &&
      error.message.includes("only verifierId, keyId, and publicKeyPem");
  }
  if (!malformedConfigRejected) {
    throw new Error("Verifier configuration accepted an unexpected private-key field.");
  }

  let oversizedConfigRejected = false;
  try {
    createTrustedSemanticAttestationAuthority(JSON.stringify(Array.from({ length: 21 }, (_, index) => ({
      verifierId: `verifier-${index}`,
      keyId: `key-${index}`,
      publicKeyPem: publicKey,
    }))));
  } catch (error) {
    oversizedConfigRejected = error instanceof Error &&
      error.message.includes("between 1 and 20 keys");
  }
  if (!oversizedConfigRejected) throw new Error("Verifier key configuration exceeded its key-count limit.");

  const authority = new TrustedSemanticAttestationAuthority([{
    verifierId: payload.verifierId,
    keyId: payload.keyId,
    publicKeyPem: publicKey,
  }]);

  // Composite key identifiers must not collide when either component contains a colon.
  new TrustedSemanticAttestationAuthority([
    { verifierId: "alpha:beta", keyId: "gamma", publicKeyPem: publicKey },
    { verifierId: "alpha", keyId: "beta:gamma", publicKeyPem: publicKey },
  ]);

  const weakPair = generateKeyPairSync("rsa", {
    modulusLength: 1024,
    publicKeyEncoding: { type: "spki", format: "pem" },
    privateKeyEncoding: { type: "pkcs8", format: "pem" },
  });
  let weakKeyRejected = false;
  try {
    new TrustedSemanticAttestationAuthority([{
      verifierId: "weak-verifier", keyId: "weak-key", publicKeyPem: weakPair.publicKey,
    }]);
  } catch (error) {
    weakKeyRejected = error instanceof Error &&
      error.message.includes("at least 2048 bits");
  }
  if (!weakKeyRejected) throw new Error("A weak RSA verifier key was accepted.");

  const optionalOnlyRequest: VerificationRequest = {
    ...request,
    criteria: [{ ...request.criteria[1], id: "optional-only", required: false }],
  };
  const optionalOnlyResult = authority.verify({
    attestation: sign({ ...payload, passedCriteria: ["optional-only"] }),
    scope, request: optionalOnlyRequest, evidenceIds: ["evidence-1"], now: () => now,
  });
  if (optionalOnlyResult.status !== "REJECTED" ||
      optionalOnlyResult.reason !== "CRITERIA_INVALID") {
    throw new Error("A verifier attestation without required criteria was accepted.");
  }

  const attestation = sign(payload);

  const duplicateCriteriaRequest: VerificationRequest = {
    ...request,
    criteria: [
      { ...request.criteria[0] },
      { ...request.criteria[0], description: "Duplicate criterion ID" },
    ],
  };
  const duplicateCriteriaResult = authority.verify({
    attestation, scope, request: duplicateCriteriaRequest,
    evidenceIds: ["evidence-1"], now: () => now,
  });
  if (duplicateCriteriaResult.status !== "REJECTED" ||
      duplicateCriteriaResult.reason !== "CRITERIA_INVALID") {
    throw new Error("Duplicate request criterion IDs were accepted."); 
  }
  const valid = authority.verify({
    attestation, scope, request, evidenceIds: ["evidence-1"], now: () => now,
  });
  if (valid.status !== "VERIFIED") throw new Error("Valid trusted verifier signature was rejected.");

  const unsignedPayloadExtension = authority.verify({
    attestation: {
      ...sign({ ...payload, unsignedExtension: "not-covered-by-canonical-signature" } as SemanticAttestationPayload),
    },
    scope, request, evidenceIds: ["evidence-1"], now: () => now,
  });
  if (unsignedPayloadExtension.status !== "REJECTED" ||
      unsignedPayloadExtension.reason !== "ATTESTATION_MALFORMED") {
    throw new Error("An unsigned extension field in the semantic payload was accepted.");
  }

  const unsignedEnvelopeExtension = authority.verify({
    attestation: { ...attestation, debug: "unsigned" } as SignedSemanticAttestation,
    scope, request, evidenceIds: ["evidence-1"], now: () => now,
  });
  if (unsignedEnvelopeExtension.status !== "REJECTED" ||
      unsignedEnvelopeExtension.reason !== "ATTESTATION_MALFORMED") {
    throw new Error("An unsigned extension field in the attestation envelope was accepted.");
  }

  const oversizedSignature = authority.verify({
    attestation: { ...attestation, signature: "A".repeat(16_385) },
    scope, request, evidenceIds: ["evidence-1"], now: () => now,
  });
  if (oversizedSignature.status !== "REJECTED" ||
      oversizedSignature.reason !== "ATTESTATION_MALFORMED") {
    throw new Error("An oversized verifier signature was accepted.");
  }

  const wrongSignatureLength = authority.verify({
    attestation: { ...attestation, signature: "AAAA" },
    scope, request, evidenceIds: ["evidence-1"], now: () => now,
  });
  if (wrongSignatureLength.status !== "REJECTED" ||
      wrongSignatureLength.reason !== "ATTESTATION_MALFORMED") {
    throw new Error("A base64 signature with the wrong RSA modulus length was accepted.");
  }

  const oversizedSummary = authority.verify({
    attestation: sign({ ...payload, summary: "x".repeat(2_049) }),
    scope, request, evidenceIds: ["evidence-1"], now: () => now,
  });
  if (oversizedSummary.status !== "REJECTED" ||
      oversizedSummary.reason !== "ATTESTATION_MALFORMED") {
    throw new Error("An oversized signed summary was accepted.");
  }

  const excessiveEvidenceIds = authority.verify({
    attestation: sign({
      ...payload,
      evidenceIds: Array.from({ length: 101 }, (_, index) => `evidence-${index}`),
    }),
    scope, request, evidenceIds: Array.from({ length: 101 }, (_, index) => `evidence-${index}`),
    now: () => now,
  });
  if (excessiveEvidenceIds.status !== "REJECTED" ||
      excessiveEvidenceIds.reason !== "ATTESTATION_MALFORMED") {
    throw new Error("An attestation with excessive evidence IDs was accepted.");
  }

  const wrongScope = authority.verify({
    attestation, scope: { ...scope, userId: "user-2" }, request,
    evidenceIds: ["evidence-1"], now: () => now,
  });
  if (wrongScope.status !== "REJECTED" || wrongScope.reason !== "SCOPE_MISMATCH") {
    throw new Error("Cross-user semantic attestation was accepted.");
  }

  const wrongEvidence = authority.verify({
    attestation, scope, request, evidenceIds: ["evidence-other"], now: () => now,
  });
  if (wrongEvidence.status !== "REJECTED" || wrongEvidence.reason !== "EVIDENCE_MISMATCH") {
    throw new Error("Attestation for different evidence was accepted.");
  }

  const altered = { ...payload, summary: "Tampered after signing." };
  const badSignature = authority.verify({
    attestation: { ...attestation, payload: altered }, scope, request,
    evidenceIds: ["evidence-1"], now: () => now,
  });
  if (badSignature.status !== "REJECTED" || badSignature.reason !== "SIGNATURE_INVALID") {
    throw new Error("Modified attestation payload passed signature verification.");
  }

  const unknownKey = new TrustedSemanticAttestationAuthority([]).verify({
    attestation, scope, request, evidenceIds: ["evidence-1"], now: () => now,
  });
  if (unknownKey.status !== "REJECTED" || unknownKey.reason !== "VERIFIER_KEY_NOT_TRUSTED") {
    throw new Error("Unconfigured verifier key was trusted.");
  }

  const falsePass = sign({
    ...payload,
    passedCriteria: [],
    partialCriteria: ["criterion-pass"],
    outcome: "PASSED",
  });
  const falsePassResult = authority.verify({
    attestation: falsePass, scope, request, evidenceIds: ["evidence-1"], now: () => now,
  });
  if (falsePassResult.status !== "REJECTED" || falsePassResult.reason !== "CRITERIA_INVALID") {
    throw new Error("A PASSED outcome without every required criterion passing was accepted.");
  }

  const stale = authority.verify({
    attestation, scope, request, evidenceIds: ["evidence-1"],
    now: () => now + 10 * 60 * 1000,
  });
  if (stale.status !== "REJECTED" || stale.reason !== "ATTESTATION_STALE") {
    throw new Error("Expired semantic attestation was accepted.");
  }

  const invalidCriteria = sign({
    ...payload, passedCriteria: ["criterion-not-in-request"],
  });
  const criteriaResult = authority.verify({
    attestation: invalidCriteria, scope, request, evidenceIds: ["evidence-1"], now: () => now,
  });
  if (criteriaResult.status !== "REJECTED" || criteriaResult.reason !== "CRITERIA_INVALID") {
    throw new Error("Attestation referencing an unknown criterion was accepted.");
  }

  // Exercise the attestation through the tenant-scoped persistence service,
  // not only through the standalone cryptographic checker.
  const adapter = new InMemoryTenantPersistenceAdapter();
  const state = createAsyncHappyStateStore(adapter, scope.organizationId, scope.workspaceId, scope.userId);
  await state.verificationRequest<VerificationRequest>().create(request.id, request);
  const evidenceService = new AsyncEvidenceService(state);
  const evidence = await evidenceService.capture({
    verificationRequestId: request.id,
    executionRequestId: request.executionRequestId,
    missionId: request.missionId,
    taskId: request.taskId,
    type: "TEST_RESULT",
    source: "TEST",
    title: "Signed semantic verifier fixture",
    content: "Synthetic evidence for contract testing.",
  });
  const serviceNow = Date.now();
  const servicePayload: SemanticAttestationPayload = {
    ...payload,
    evidenceIds: [evidence.id],
    verifiedAt: new Date(serviceNow - 1_000).toISOString(),
  };
  const serviceAttestation = sign(servicePayload);
  const service = new AsyncVerificationService(state, authority);
  const provisional = await service.verify(request.id, [evidence.id]);
  if (provisional.status !== "PARTIAL" ||
      provisional.failureReason !== "SEMANTIC_VERIFIER_NOT_CONNECTED") {
    throw new Error("Untrusted evidence was not held at PARTIAL before signed verification.");
  }
  const persistedResult = await service.verifyWithTrustedAttestation(
    request.id, [evidence.id], serviceAttestation,
  );
  if (persistedResult.status !== "PASSED" || persistedResult.evidenceIds[0] !== evidence.id) {
    throw new Error("Trusted signed semantic attestation was not persisted against its exact evidence.");
  }

  let unconfiguredAuthorityRejected = false;
  try {
    await new AsyncVerificationService(state).verifyWithTrustedAttestation(
      "another-request", [], serviceAttestation,
    );
  } catch (error) {
    unconfiguredAuthorityRejected = error instanceof Error &&
      error.message === "TRUSTED_SEMANTIC_VERIFIER_NOT_CONFIGURED";
  }
  if (!unconfiguredAuthorityRejected) {
    throw new Error("Semantic verification proceeded without a configured trusted key authority.");
  }

  // End-to-end durable task completion: the orchestrator independently
  // re-verifies the stored signature and evidence inside its transaction.
  const durableAdapter = new InMemoryTenantPersistenceAdapter();
  const durableScope = { organizationId: "org-durable", workspaceId: "workspace-durable", userId: "user-durable" };
  const durableOrchestrator = new MissionOrchestrator(null, authority);
  const plan = new ReasoningOrchestrator().createExecutionPlan({
    goal: "Complete a task using a signed semantic verifier attestation.",
  });
  if (plan.status !== "READY") throw new Error("Could not create the durable verification test plan.");
  const snapshot = await durableOrchestrator.createDurable(plan, durableScope, durableAdapter);
  const taskId = snapshot.graph.roots[0];
  if (!taskId) throw new Error("Durable verification test mission has no root task.");
  const taskRecord = await durableAdapter.get<{ verificationRequired: boolean }>(
    durableScope, "TASK", taskId,
  );
  if (!taskRecord) throw new Error("Durable verification test task is missing.");
  await durableAdapter.update(durableScope, "TASK", taskId, taskRecord.version, {
    ...taskRecord.data,
    verificationRequired: true,
  });
  await durableOrchestrator.transitionTaskDurable({
    scope: durableScope, persistence: durableAdapter,
    missionId: snapshot.mission.id, taskId, status: "RUNNING",
  });
  await durableOrchestrator.transitionTaskDurable({
    scope: durableScope, persistence: durableAdapter,
    missionId: snapshot.mission.id, taskId, status: "VERIFYING",
  });

  const durableState = createAsyncHappyStateStore(
    durableAdapter, durableScope.organizationId, durableScope.workspaceId, durableScope.userId,
  );
  const durableVerification = new AsyncVerificationService(durableState, authority);
  const durableEvidence = new AsyncEvidenceService(durableState);
  const durableRequest: VerificationRequest = {
    id: "durable-verification-1",
    missionId: snapshot.mission.id,
    taskId,
    description: "Verify the durable task result.",
    criteria: [{
      id: "durable-criterion-1",
      description: "Task result is confirmed",
      expected: "confirmed",
      required: true,
    }],
    preferredMethods: ["TEST"],
    requiresEvidence: true,
    createdAt: new Date().toISOString(),
  };
  await durableVerification.registerRequest(durableRequest);
  const durableEvidenceRecord = await durableEvidence.capture({
    verificationRequestId: durableRequest.id,
    missionId: durableRequest.missionId,
    taskId: durableRequest.taskId,
    type: "TEST_RESULT",
    source: "TEST",
    title: "Durable verification evidence",
    content: "Synthetic signed-verifier test evidence.",
  });
  const durableNow = Date.now();
  const durablePayload: SemanticAttestationPayload = {
    ...payload,
    organizationId: durableScope.organizationId,
    workspaceId: durableScope.workspaceId,
    userId: durableScope.userId,
    requestId: durableRequest.id,
    missionId: durableRequest.missionId,
    taskId: durableRequest.taskId,
    executionRequestId: null,
    evidenceIds: [durableEvidenceRecord.id],
    passedCriteria: ["durable-criterion-1"],
    failedCriteria: [],
    partialCriteria: [],
    outcome: "PASSED",
    verifiedAt: new Date(durableNow - 1_000).toISOString(),
  };
  const durableAttestation = sign(durablePayload);
  const durableResult = await durableVerification.verifyWithTrustedAttestation(
    durableRequest.id, [durableEvidenceRecord.id], durableAttestation,
  );
  if (durableResult.status !== "PASSED" || !durableResult.attestation) {
    throw new Error("Durable verification service did not persist the signed PASSED attestation.");
  }
  const completed = await durableOrchestrator.transitionTaskDurable({
    scope: durableScope,
    persistence: durableAdapter,
    missionId: snapshot.mission.id,
    taskId,
    status: "COMPLETED",
    verificationRequestId: durableRequest.id,
  });
  if (completed.graph.tasks.find((task) => task.id === taskId)?.status !== "COMPLETED") {
    throw new Error("Orchestrator did not complete a task with a valid trusted semantic attestation.");
  }

  console.log("Trusted semantic attestation signature and binding contract: PASS");
  console.log({
    trustedKeyAllowlist: true,
    cryptographicSignature: true,
    tenantBinding: true,
    requestAndEvidenceBinding: true,
    criteriaBinding: true,
    freshnessWindow: true,
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
