import { createVerify } from "node:crypto";
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
    const indexed = new Map<string, TrustedSemanticVerifierKey>();
    for (const key of keys) {
      if (!key.verifierId.trim() || !key.keyId.trim() || !key.publicKeyPem.trim()) {
        throw new Error("Trusted semantic verifier keys require verifier ID, key ID, and public key.");
      }
      const index = `${key.verifierId}:${key.keyId}`;
      if (indexed.has(index)) throw new Error("Trusted semantic verifier key IDs must be unique.");
      indexed.set(index, Object.freeze({ ...key }));
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
    if (!attestation || typeof attestation !== "object" ||
        !attestation.payload || typeof attestation.payload !== "object" ||
        typeof attestation.signature !== "string" || !attestation.signature.trim()) {
      return { status: "REJECTED", reason: "ATTESTATION_MALFORMED" };
    }

    const payload = attestation.payload;
    if (payload.schemaVersion !== 1 ||
        !payload.verifierId?.trim() || !payload.keyId?.trim() ||
        !payload.organizationId?.trim() || !payload.workspaceId?.trim() ||
        !payload.userId?.trim() || !payload.requestId?.trim() ||
        !payload.missionId?.trim() || !payload.taskId?.trim() ||
        !Array.isArray(payload.evidenceIds) ||
        !Array.isArray(payload.passedCriteria) ||
        !Array.isArray(payload.failedCriteria) ||
        !Array.isArray(payload.partialCriteria) ||
        !["PASSED", "FAILED", "PARTIAL"].includes(payload.outcome) ||
        !["HIGH", "MEDIUM", "LOW"].includes(payload.confidence) ||
        !payload.summary?.trim() || !payload.verifiedAt?.trim()) {
      return { status: "REJECTED", reason: "ATTESTATION_MALFORMED" };
    }

    const key = this.keys.get(`${payload.verifierId}:${payload.keyId}`);
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

    const criterionIds = new Set(input.request.criteria.map((criterion) => criterion.id));
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
      const verifier = createVerify("RSA-SHA256");
      verifier.update(canonicalSemanticAttestationPayload(payload));
      verifier.end();
      validSignature = verifier.verify(key.publicKeyPem, attestation.signature, "base64");
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
