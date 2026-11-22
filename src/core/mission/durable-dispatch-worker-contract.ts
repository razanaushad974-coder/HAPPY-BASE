import type { WorkerIdentityResolution } from "./trusted-worker-identity";
import type { ExecutionRequest } from "../execution/types";

export type ProviderDispatchObservation =
  | { kind: "ACKNOWLEDGED"; provider: string; providerRequestId: string; response: unknown }
  | { kind: "DEFINITIVE_FAILURE"; provider: string; code: string; message: string };

export interface IdempotentDispatchProvider {
  readonly providerId: string;
  /** Must mean the provider deduplicates repeated calls for the same key. */
  readonly supportsIdempotencyKeys: true;
  dispatch(
    request: ExecutionRequest,
    options: { idempotencyKey: string },
  ): Promise<ProviderDispatchObservation>;
}

export interface ClaimedDispatch {
  outboxId: string;
  idempotencyKey: string;
  executionRequestId: string;
  leaseId: string;
  ownerId: string;
  fencingToken: number;
  request: ExecutionRequest;
}

export type PersistedDispatchOutcome =
  | { status: "ACKNOWLEDGED"; outcome: Record<string, unknown> }
  | { status: "FAILED"; outcome: Record<string, unknown> }
  | { status: "AMBIGUOUS"; outcome: Record<string, unknown> }
  | { status: "RECONCILIATION_REQUIRED"; outcome: Record<string, unknown> };

export interface DispatchOutcomeRecorder {
  /** Must be a tenant-authenticated, fenced, one-time database operation. */
  recordOnce(dispatch: ClaimedDispatch, outcome: PersistedDispatchOutcome): Promise<void>;
}

export type DispatchWorkerResult =
  | { status: "RECORDED"; outcome: PersistedDispatchOutcome["status"] }
  | { status: "RECONCILIATION_REQUIRED"; reason: string }
  | { status: "OUTCOME_PERSISTENCE_FAILED"; reason: string };

/**
 * Processes an already-claimed outbox item exactly once from this worker's
 * perspective. The durable claim and outcome recorder must be backed by the
 * authenticated PostgreSQL RPCs. This function is not a polling loop and
 * cannot make a non-idempotent provider safe.
 */
export async function dispatchClaimedOutboxItem(
  dispatch: ClaimedDispatch,
  workerIdentity: WorkerIdentityResolution,
  provider: IdempotentDispatchProvider,
  recorder: DispatchOutcomeRecorder,
): Promise<DispatchWorkerResult> {
  if (
    workerIdentity.status !== "VERIFIED" ||
    workerIdentity.identity.principal !== dispatch.ownerId ||
    !workerIdentity.identity.capabilities.includes(dispatch.request.capability)
  ) {
    return { status: "RECONCILIATION_REQUIRED", reason: "TRUSTED_WORKER_IDENTITY_OR_CAPABILITY_MISMATCH" };
  }

  if (
    !dispatch.outboxId.trim() ||
    !dispatch.idempotencyKey.trim() ||
    !dispatch.executionRequestId.trim() ||
    !dispatch.leaseId.trim() ||
    !dispatch.ownerId.trim() ||
    !Number.isSafeInteger(dispatch.fencingToken) ||
    dispatch.fencingToken < 1 ||
    dispatch.request.id !== dispatch.executionRequestId ||
    !dispatch.request.missionId.trim() ||
    !dispatch.request.taskId.trim()
  ) {
    return { status: "RECONCILIATION_REQUIRED", reason: "CLAIMED_DISPATCH_BINDING_INVALID" };
  }

  if (!provider.providerId.trim() || provider.supportsIdempotencyKeys !== true) {
    return { status: "RECONCILIATION_REQUIRED", reason: "PROVIDER_IDEMPOTENCY_NOT_GUARANTEED" };
  }

  let outcome: PersistedDispatchOutcome;
  try {
    const observation = await provider.dispatch(dispatch.request, {
      idempotencyKey: dispatch.idempotencyKey,
    });
    if (observation.kind === "ACKNOWLEDGED") {
      if (!observation.provider.trim() || !observation.providerRequestId.trim()) {
        outcome = {
          status: "AMBIGUOUS",
          outcome: { reason: "PROVIDER_ACKNOWLEDGEMENT_MISSING_IDENTITY", provider: provider.providerId },
        };
      } else {
        outcome = {
          status: "ACKNOWLEDGED",
          outcome: {
            provider: observation.provider,
            providerRequestId: observation.providerRequestId,
            response: observation.response,
          },
        };
      }
    } else {
      outcome = {
        status: "FAILED",
        outcome: { provider: observation.provider, code: observation.code, message: observation.message },
      };
    }
  } catch {
    // A thrown network/transport error cannot prove the provider did not act.
    outcome = {
      status: "AMBIGUOUS",
      outcome: { provider: provider.providerId, reason: "PROVIDER_CALL_OUTCOME_UNKNOWN" },
    };
  }

  try {
    await recorder.recordOnce(dispatch, outcome);
  } catch {
    // Never call the provider again from this invocation. The DISPATCHED
    // outbox item must be reconciled against provider-side idempotency/status.
    return {
      status: "OUTCOME_PERSISTENCE_FAILED",
      reason: "PROVIDER_RESULT_NOT_DURABLY_RECORDED; DO_NOT_REPLAY",
    };
  }

  return { status: "RECORDED", outcome: outcome.status };
}
