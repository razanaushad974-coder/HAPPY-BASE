export type ProviderReconciliationObservation =
  | { status: "SUCCEEDED"; providerRequestId: string; result: unknown }
  | { status: "FAILED"; providerRequestId: string; code: string; message: string }
  | { status: "PROCESSING"; providerRequestId: string }
  | { status: "NOT_FOUND" }
  | { status: "UNKNOWN"; reason: string };

export type ProviderReconciliationDecision =
  | { status: "VERIFICATION_REQUIRED"; providerRequestId: string; result: unknown }
  | { status: "FAILED_EXECUTION_REVIEW_REQUIRED"; providerRequestId: string; code: string; message: string }
  | { status: "PROVIDER_STILL_PROCESSING"; providerRequestId: string }
  | { status: "NO_PROVIDER_RECORD_REVIEW_REQUIRED" }
  | { status: "RECONCILIATION_REQUIRED"; reason: string };

export interface ProviderStatusReader {
  readonly providerId: string;
  readonly supportsIdempotencyKeys: true;
  lookupByIdempotencyKey(key: string): Promise<ProviderReconciliationObservation>;
}

export interface ProviderReconciliationEvidence {
  outboxId: string;
  idempotencyKey: string;
  providerId: string;
  observedAt: string;
  observation: ProviderReconciliationObservation;
}

export interface ProviderReconciliationEvidenceStore {
  /** Append-only evidence; must never overwrite the original dispatch outcome. */
  append(evidence: ProviderReconciliationEvidence): Promise<void>;
}

export interface ReconciliationTarget {
  outboxId: string;
  idempotencyKey: string;
  providerId: string;
  originalOutcome: "AMBIGUOUS" | "RECONCILIATION_REQUIRED";
}

export type ReconciliationResult =
  | { status: "RECORDED"; decision: ProviderReconciliationDecision }
  | { status: "EVIDENCE_PERSISTENCE_FAILED"; decision: ProviderReconciliationDecision }
  | { status: "RECONCILIATION_REQUIRED"; reason: string };

/**
 * Performs a read-only provider status lookup and appends its observation.
 * It never dispatches, retries, changes task state, or overwrites the first
 * dispatch outcome. A provider "not found" result is not proof that a request
 * was never accepted and therefore never authorizes replay.
 */
export async function reconcileProviderDispatch(
  target: ReconciliationTarget,
  provider: ProviderStatusReader,
  evidenceStore: ProviderReconciliationEvidenceStore,
  observedAt = new Date().toISOString(),
): Promise<ReconciliationResult> {
  if (
    !target.outboxId.trim() ||
    !target.idempotencyKey.trim() ||
    !target.providerId.trim() ||
    target.providerId !== provider.providerId ||
    (target.originalOutcome !== "AMBIGUOUS" &&
      target.originalOutcome !== "RECONCILIATION_REQUIRED")
  ) {
    return { status: "RECONCILIATION_REQUIRED", reason: "RECONCILIATION_TARGET_INVALID" };
  }
  if (provider.supportsIdempotencyKeys !== true) {
    return { status: "RECONCILIATION_REQUIRED", reason: "PROVIDER_IDEMPOTENCY_NOT_GUARANTEED" };
  }

  let observation: ProviderReconciliationObservation;
  try {
    observation = await provider.lookupByIdempotencyKey(target.idempotencyKey);
  } catch {
    return { status: "RECONCILIATION_REQUIRED", reason: "PROVIDER_STATUS_LOOKUP_FAILED" };
  }

  let decision: ProviderReconciliationDecision;
  switch (observation.status) {
    case "SUCCEEDED":
      decision = observation.providerRequestId.trim()
        ? { status: "VERIFICATION_REQUIRED", providerRequestId: observation.providerRequestId, result: observation.result }
        : { status: "RECONCILIATION_REQUIRED", reason: "PROVIDER_SUCCESS_MISSING_REQUEST_ID" };
      break;
    case "FAILED":
      decision = observation.providerRequestId.trim()
        ? { status: "FAILED_EXECUTION_REVIEW_REQUIRED", providerRequestId: observation.providerRequestId, code: observation.code, message: observation.message }
        : { status: "RECONCILIATION_REQUIRED", reason: "PROVIDER_FAILURE_MISSING_REQUEST_ID" };
      break;
    case "PROCESSING":
      decision = observation.providerRequestId.trim()
        ? { status: "PROVIDER_STILL_PROCESSING", providerRequestId: observation.providerRequestId }
        : { status: "RECONCILIATION_REQUIRED", reason: "PROVIDER_PROCESSING_MISSING_REQUEST_ID" };
      break;
    case "NOT_FOUND":
      decision = { status: "NO_PROVIDER_RECORD_REVIEW_REQUIRED" };
      break;
    case "UNKNOWN":
      decision = { status: "RECONCILIATION_REQUIRED", reason: observation.reason };
      break;
  }

  try {
    await evidenceStore.append({
      outboxId: target.outboxId,
      idempotencyKey: target.idempotencyKey,
      providerId: target.providerId,
      observedAt,
      observation,
    });
  } catch {
    return { status: "EVIDENCE_PERSISTENCE_FAILED", decision };
  }
  return { status: "RECORDED", decision };
}
