import { createPublicKey, createVerify } from "node:crypto";
import type { TenantScope } from "../state/types";
import type { VerificationRequest } from "./types";

export interface SemanticAttestationPayload {
  readonly schemaVersion: 1;
  readonly verifierId: string;
  readonly keyId: string;
  readonly organizationId: string;
  readonly workspaceId: string;
  readonly userId: string;
  readonly requestId: string;
  readonly missionId: string;
  readonly taskId: string;
  readonly executionRequestId: string | null;
  readonly evidenceIds: readonly string[];
  readonly passedCriteria: readonly string[];
  readonly failedCriteria: readonly string[];
  readonly partialCriteria: readonly string[];
  readonly outcome: "PASSED" | "FAILED" | "PARTIAL";
  readonly confidence: "HIGH" | "MEDIUM" | "LOW";
  readonly summary: string;
  readonly verifiedAt: string;
}

export interface SignedSemanticAttestation {
  readonly payload: SemanticAttestationPayload;
  readonly signature: string;
}

export interface TrustedSemanticVerifierKey {
  readonly verifierId: string;
  readonly keyId: string;
  readonly publicKeyPem: string;
}

export type SemanticAttestationRejection =
  | "ATTESTATION_MALFORMED"
  | "VERIFIER_KEY_NOT_TRUSTED"
  | "SIGNATURE_INVALID"
  | "SCOPE_MISMATCH"
  | "REQUEST_MISMATCH"
  | "EVIDENCE_MISMATCH"
  | "CRITERIA_INVALID"
  | "ATTESTATION_STALE";

export type SemanticAttestationCheck =
  | { readonly status: "VERIFIED"; readonly payload: SemanticAttestationPayload }
  | { readonly status: "REJECTED"; readonly reason: SemanticAttestationRejection };

/**
 * Verifies signed semantic decisions against an explicit public-key allowlist.
 * The allowlist must be constructed by trusted server composition from
 * operator-controlled configuration; never accept keys supplied by a request.
 *
 * This class verifies attestations only. It does not create signatures,
 * establish verifier identity, or make an unconfigured verifier trusted.
 */
export class TrustedSemanticAttestationAuthority {
  private readonly keys: ReadonlyMap<string, TrustedSemanticVerifierKey>;

  constructor(
    keys: readonly TrustedSemanticVerifierKey[],
    private readonly maxAgeMilliseconds = 5 * 60 * 1000,
  ) {
    if (!Number.isSafeInteger(maxAgeMilliseconds) ||
        maxAgeMilliseconds < 1 || maxAgeMilliseconds > 5 * 60 * 1000) {
      throw new Error("Semantic attestation freshness must be between 1 ms and 5 minutes.");
    }
    const indexed = new Map<string, TrustedSemanticVerifierKey>();
    for (const key of keys) {
      if (typeof key.verifierId !== "string" || typeof key.keyId !== "string" ||
          typeof key.publicKeyPem !== "string" ||
          !key.verifierId.trim() || !key.keyId.trim() || !key.publicKeyPem.trim() ||
          key.verifierId.length > 128 || key.keyId.length > 128 ||
          key.publicKeyPem.length > 16_384) {
        throw new Error("Trusted semantic verifier keys require verifier ID, key ID, and public key.");
      }
      const verifierId = key.verifierId.trim();
      const keyId = key.keyId.trim();
      const index = JSON.stringify([verifierId, keyId]);
      if (indexed.has(index)) throw new Error("Trusted semantic verifier key IDs must be unique.");
      let publicKey;
      try {
        publicKey = createPublicKey(key.publicKeyPem);
      } catch {
        throw new Error("Trusted semantic verifier public key is not valid PEM.");
      }
      if (publicKey.asymmetricKeyType !== "rsa" ||
          !publicKey.asymmetricKeyDetails?.modulusLength ||
          publicKey.asymmetricKeyDetails.modulusLength < 2048) {
        throw new Error("Trusted semantic verifier keys must be RSA public keys of at least 2048 bits.");
      }
      indexed.set(index, Object.freeze({
        ...key,
        verifierId,
        keyId,
        publicKeyPem: publicKey.export({ type: "spki", format: "pem" }).toString(),
      }));
    }
    this.keys = indexed;
  }

  verify(input: {
    readonly attestation: SignedSemanticAttestation;
    readonly scope: TenantScope & { userId: string };
    readonly request: VerificationRequest;
    readonly evidenceIds: readonly string[];
    readonly now?: () => number;
  }): SemanticAttestationCheck {
    const { attestation } = input;
    if (!attestation || typeof attestation !== "object" || Array.isArray(attestation) ||
        Object.keys(attestation).sort().join(",") !== "payload,signature" ||
        !attestation.payload || typeof attestation.payload !== "object" ||
        Array.isArray(attestation.payload) ||
        typeof attestation.signature !== "string" ||
        attestation.signature.length === 0 || attestation.signature.length > 16_384 ||
        !/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/.test(attestation.signature)) {
      return { status: "REJECTED", reason: "ATTESTATION_MALFORMED" };
    }

    const payload = attestation.payload;
    const expectedPayloadFields = [
      "schemaVersion", "verifierId", "keyId", "organizationId", "workspaceId",
      "userId", "requestId", "missionId", "taskId", "executionRequestId",
      "evidenceIds", "passedCriteria", "failedCriteria", "partialCriteria",
      "outcome", "confidence", "summary", "verifiedAt",
    ].sort().join(",");
    if (Object.keys(payload).sort().join(",") !== expectedPayloadFields) {
      return { status: "REJECTED", reason: "ATTESTATION_MALFORMED" };
    }
    const requiredText = [
      payload.verifierId, payload.keyId, payload.organizationId,
      payload.workspaceId, payload.userId, payload.requestId,
      payload.missionId, payload.taskId, payload.summary, payload.verifiedAt,
    ];
    const boundedIds = (values: unknown): values is string[] =>
      Array.isArray(values) && values.length <= 100 &&
      values.every((id) => typeof id === "string" && id.trim().length > 0 && id.length <= 256);
    if (payload.schemaVersion !== 1 ||
        requiredText.some((value) => typeof value !== "string" || !value.trim()) ||
        payload.verifierId.length > 128 || payload.keyId.length > 128 ||
        payload.organizationId.length > 128 || payload.workspaceId.length > 128 ||
        payload.userId.length > 128 || payload.requestId.length > 256 ||
        payload.missionId.length > 256 || payload.taskId.length > 256 ||
        payload.summary.length > 2_048 || payload.verifiedAt.length > 64 ||
        (payload.executionRequestId !== null &&
          (typeof payload.executionRequestId !== "string" || payload.executionRequestId.length > 256)) ||
        !boundedIds(payload.evidenceIds) ||
        !boundedIds(payload.passedCriteria) ||
        !boundedIds(payload.failedCriteria) ||
        !boundedIds(payload.partialCriteria) ||
        !["PASSED", "FAILED", "PARTIAL"].includes(payload.outcome) ||
        !["HIGH", "MEDIUM", "LOW"].includes(payload.confidence)) {
      return { status: "REJECTED", reason: "ATTESTATION_MALFORMED" };
    }

    const key = this.keys.get(JSON.stringify([payload.verifierId, payload.keyId]));
    if (!key) return { status: "REJECTED", reason: "VERIFIER_KEY_NOT_TRUSTED" };

    if (payload.organizationId !== input.scope.organizationId ||
        payload.workspaceId !== input.scope.workspaceId ||
        payload.userId !== input.scope.userId) {
      return { status: "REJECTED", reason: "SCOPE_MISMATCH" };
    }
    if (payload.requestId !== input.request.id ||
        payload.missionId !== input.request.missionId ||
        payload.taskId !== input.request.taskId ||
        payload.executionRequestId !== (input.request.executionRequestId || null)) {
      return { status: "REJECTED", reason: "REQUEST_MISMATCH" };
    }

    const normalize = (values: readonly string[]) => [...values].sort();
    if (payload.evidenceIds.some((id) => typeof id !== "string" || !id.trim()) ||
        new Set(payload.evidenceIds).size !== payload.evidenceIds.length ||
        JSON.stringify(normalize(payload.evidenceIds)) !== JSON.stringify(normalize(input.evidenceIds))) {
      return { status: "REJECTED", reason: "EVIDENCE_MISMATCH" };
    }

    const requestCriterionIds = input.request.criteria.map((criterion) => criterion.id);
    if (requestCriterionIds.length === 0 ||
        requestCriterionIds.some((id) => typeof id !== "string" || !id.trim()) ||
        new Set(requestCriterionIds).size !== requestCriterionIds.length ||
        !input.request.criteria.some((criterion) => criterion.required)) {
      return { status: "REJECTED", reason: "CRITERIA_INVALID" };
    }

    const criterionIds = new Set(requestCriterionIds);
    const passed = new Set(payload.passedCriteria);
    const failed = new Set(payload.failedCriteria);
    const partial = new Set(payload.partialCriteria);
    const allReported = [
      ...payload.passedCriteria,
      ...payload.failedCriteria,
      ...payload.partialCriteria,
    ];
    if (allReported.some((id) => !criterionIds.has(id)) ||
        new Set(allReported).size !== allReported.length) {
      return { status: "REJECTED", reason: "CRITERIA_INVALID" };
    }
    const required = input.request.criteria.filter((criterion) => criterion.required).map((criterion) => criterion.id);
    if (required.some((id) => !passed.has(id) && !failed.has(id) && !partial.has(id))) {
      return { status: "REJECTED", reason: "CRITERIA_INVALID" };
    }
    const expectedOutcome = required.some((id) => failed.has(id))
      ? "FAILED"
      : required.every((id) => passed.has(id))
        ? "PASSED"
        : "PARTIAL";
    if (payload.outcome !== expectedOutcome) {
      return { status: "REJECTED", reason: "CRITERIA_INVALID" };
    }

    const verifiedAt = Date.parse(payload.verifiedAt);
    const now = (input.now ?? Date.now)();
    if (!Number.isFinite(verifiedAt) || verifiedAt > now || now - verifiedAt > this.maxAgeMilliseconds) {
      return { status: "REJECTED", reason: "ATTESTATION_STALE" };
    }

    let validSignature = false;
    try {
      const trustedPublicKey = createPublicKey(key.publicKeyPem);
      const expectedSignatureBytes =
        (trustedPublicKey.asymmetricKeyDetails?.modulusLength ?? 0) / 8;
      const signatureBytes = Buffer.from(attestation.signature, "base64");
      if (signatureBytes.length !== expectedSignatureBytes ||
          signatureBytes.toString("base64") !== attestation.signature) {
        return { status: "REJECTED", reason: "ATTESTATION_MALFORMED" };
      }
      const canonicalPayload = canonicalSemanticAttestationPayload(payload);
      if (Buffer.byteLength(canonicalPayload, "utf8") > 32_768) {
        return { status: "REJECTED", reason: "ATTESTATION_MALFORMED" };
      }
      const verifier = createVerify("RSA-SHA256");
      verifier.update(canonicalPayload);
      verifier.end();
      validSignature = verifier.verify(trustedPublicKey, signatureBytes);
    } catch {
      validSignature = false;
    }
    if (!validSignature) return { status: "REJECTED", reason: "SIGNATURE_INVALID" };

    return { status: "VERIFIED", payload };
  }
}

/** Stable field order is part of the signed wire contract. */
export function canonicalSemanticAttestationPayload(
  payload: SemanticAttestationPayload,
): string {
  return JSON.stringify({
    schemaVersion: payload.schemaVersion,
    verifierId: payload.verifierId,
    keyId: payload.keyId,
    organizationId: payload.organizationId,
    workspaceId: payload.workspaceId,
    userId: payload.userId,
    requestId: payload.requestId,
    missionId: payload.missionId,
    taskId: payload.taskId,
    executionRequestId: payload.executionRequestId,
    evidenceIds: [...payload.evidenceIds].sort(),
    passedCriteria: [...payload.passedCriteria].sort(),
    failedCriteria: [...payload.failedCriteria].sort(),
    partialCriteria: [...payload.partialCriteria].sort(),
    outcome: payload.outcome,
    confidence: payload.confidence,
    summary: payload.summary,
    verifiedAt: payload.verifiedAt,
  });
}
