import { generateKeyPairSync, createSign } from "node:crypto";
import {
  canonicalSemanticAttestationPayload,
  TrustedSemanticAttestationAuthority,
  type SemanticAttestationPayload,
  type SignedSemanticAttestation,
} from "../../../core/verification/semantic-attestation";
import type { VerificationRequest } from "../../../core/verification/types";

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
  const authority = new TrustedSemanticAttestationAuthority([{
    verifierId: payload.verifierId,
    keyId: payload.keyId,
    publicKeyPem: publicKey,
  }]);
  const attestation = sign(payload);
  const valid = authority.verify({
    attestation, scope, request, evidenceIds: ["evidence-1"], now: () => now,
  });
  if (valid.status !== "VERIFIED") throw new Error("Valid trusted verifier signature was rejected.");

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
