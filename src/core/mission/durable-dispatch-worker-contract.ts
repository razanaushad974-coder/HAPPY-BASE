import { isVerifiedWorkerIdentity, type WorkerCapability, type WorkerIdentityResolution } from "./trusted-worker-identity";
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

export interface TrustedWorkerIdentityResolver {
  /** Must perform a fresh server-side credential read and cryptographic verification. */
  getVerifiedWorkerIdentity(): Promise<WorkerIdentityResolution>;
}

/**
 * Server-side composition entry point. It resolves workload identity afresh
 * for this claimed item and never accepts identity claims from the dispatch
 * payload or a human-session request.
 */
export async function dispatchWithTrustedWorkerIdentity(
  identityProvider: TrustedWorkerIdentityResolver,
  dispatch: ClaimedDispatch,
  provider: IdempotentDispatchProvider,
  recorder: DispatchOutcomeRecorder,
  now: () => number = () => Date.now(),
): Promise<DispatchWorkerResult> {
  let identity: WorkerIdentityResolution;
  try {
    identity = await identityProvider.getVerifiedWorkerIdentity();
  } catch {
    return { status: "RECONCILIATION_REQUIRED", reason: "TRUSTED_WORKER_IDENTITY_UNAVAILABLE" };
  }
  return dispatchClaimedOutboxItem(dispatch, identity, provider, recorder, now);
}

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
  now: () => number = () => Date.now(),
): Promise<DispatchWorkerResult> {
  if (
    !dispatch || typeof dispatch !== "object" ||
    !workerIdentity || typeof workerIdentity !== "object" ||
    workerIdentity.status !== "VERIFIED" ||
    !isVerifiedWorkerIdentity(workerIdentity.identity) ||
    typeof workerIdentity.identity.principal !== "string" ||
    typeof workerIdentity.identity.issuer !== "string" || !workerIdentity.identity.issuer.trim() ||
    typeof workerIdentity.identity.audience !== "string" || !workerIdentity.identity.audience.trim() ||
    typeof workerIdentity.identity.environment !== "string" || !workerIdentity.identity.environment.trim() ||
    typeof workerIdentity.identity.tokenId !== "string" || !workerIdentity.identity.tokenId.trim() ||
    !Number.isSafeInteger(workerIdentity.identity.issuedAt) ||
    !Number.isSafeInteger(workerIdentity.identity.expiresAt) ||
    workerIdentity.identity.expiresAt <= workerIdentity.identity.issuedAt ||
    !Array.isArray(workerIdentity.identity.capabilities) ||
    !dispatch.request || typeof dispatch.request !== "object" ||
    typeof dispatch.request.capability !== "string" ||
    workerIdentity.identity.principal !== dispatch.ownerId ||
    !workerIdentity.identity.capabilities.includes(dispatch.request.capability as WorkerCapability)
  ) {
    return { status: "RECONCILIATION_REQUIRED", reason: "TRUSTED_WORKER_IDENTITY_OR_CAPABILITY_MISMATCH" };
  }

  let nowMs: number;
  try {
    nowMs = now();
  } catch {
    return { status: "RECONCILIATION_REQUIRED", reason: "WORKER_IDENTITY_CLOCK_UNAVAILABLE" };
  }
  if (!Number.isFinite(nowMs) || nowMs < 0 ||
      workerIdentity.identity.expiresAt <= Math.floor(nowMs / 1000)) {
    return { status: "RECONCILIATION_REQUIRED", reason: "WORKER_IDENTITY_EXPIRED" };
  }

  if (
    typeof dispatch.outboxId !== "string" || !dispatch.outboxId.trim() ||
    typeof dispatch.idempotencyKey !== "string" || !dispatch.idempotencyKey.trim() ||
    typeof dispatch.executionRequestId !== "string" || !dispatch.executionRequestId.trim() ||
    typeof dispatch.leaseId !== "string" || !dispatch.leaseId.trim() ||
    typeof dispatch.ownerId !== "string" || !dispatch.ownerId.trim() ||
    !Number.isSafeInteger(dispatch.fencingToken) ||
    dispatch.fencingToken < 1 ||
    typeof dispatch.request.id !== "string" ||
    dispatch.request.id !== dispatch.executionRequestId ||
    typeof dispatch.request.missionId !== "string" || !dispatch.request.missionId.trim() ||
    typeof dispatch.request.taskId !== "string" || !dispatch.request.taskId.trim()
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
