import { isVerifiedWorkerIdentity, type WorkerCapability, type WorkerIdentityResolution } from "./trusted-worker-identity";
import type { ExecutionRequest, ExecutionRisk } from "../execution/types";
import type {
  WorkerDatabaseBroker,
  WorkerDispatchOutbox,
  WorkerTaskLease,
  WorkerTenantScope,
} from "./worker-database-broker";
import {
  reconcileProviderDispatch,
  type ProviderStatusReader,
  type ProviderReconciliationEvidenceStore,
  type ReconciliationResult,
} from "./provider-dispatch-reconciliation";
import {
  createExecutionIdempotencyKey,
  createExecutionPayloadDigest,
  type MissionTaskLease,
} from "./durable-scheduler-contract";

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

export type ApprovedTaskEnqueueResult =
  | { status: "ENQUEUED"; outbox: WorkerDispatchOutbox; outboxId: string; executionRequestId: string; idempotencyKey: string }
  | { status: "CLAIM_FAILED" | "APPROVED_REQUEST_INVALID" | "ENQUEUE_RESULT_UNKNOWN"; missionId: string; taskId: string };

/** One bounded task claim and immutable outbox enqueue. Never polls or retries. */
export async function claimAndEnqueueApprovedTask(input: {
  broker: Pick<WorkerDatabaseBroker, "claimTask" | "heartbeatLease" | "enqueueDispatch">;
  tenantScope: WorkerTenantScope;
  missionId: string;
  taskId: string;
  ownerId: string;
  leaseMilliseconds: number;
}): Promise<ApprovedTaskEnqueueResult> {
  const { missionId, taskId } = input;
  let lease: WorkerTaskLease;
  try {
    lease = await input.broker.claimTask({
      tenantScope: input.tenantScope, missionId, taskId,
      ownerId: input.ownerId, leaseMilliseconds: input.leaseMilliseconds,
    });
  } catch {
    return { status: "CLAIM_FAILED", missionId, taskId };
  }

  const request = lease.executionRequest;
  if (!request || request.missionId !== missionId || request.taskId !== taskId ||
      request.approved !== true || request.requiresApproval !== true || request.risk !== "HIGH") {
    return { status: "APPROVED_REQUEST_INVALID", missionId, taskId };
  }

  try {
    await input.broker.heartbeatLease({
      tenantScope: input.tenantScope, missionId, taskId,
      leaseId: lease.leaseId, ownerId: input.ownerId,
      fencingToken: lease.fencingToken, leaseMilliseconds: input.leaseMilliseconds,
    });
  } catch {
    return { status: "ENQUEUE_RESULT_UNKNOWN", missionId, taskId };
  }

  const missionLease: MissionTaskLease = {
    id: lease.leaseId,
    scope: input.tenantScope,
    missionId,
    taskId,
    ownerId: input.ownerId,
    attempt: lease.attempt,
    fencingToken: lease.fencingToken,
    expiresAt: lease.expiresAt,
  };
  const idempotencyKey = createExecutionIdempotencyKey(missionLease, request);
  const payloadDigest = createExecutionPayloadDigest(request);
  const payload = Object.freeze({
    id: request.id,
    taskId: request.taskId,
    missionId: request.missionId,
    capability: request.capability,
    action: request.action,
    input: request.input,
    targetReference: request.targetReference ?? null,
    requiresApproval: true,
    approved: true,
    risk: request.risk,
    createdAt: request.createdAt,
  });

  try {
    const outbox = await input.broker.enqueueDispatch({
      tenantScope: input.tenantScope, missionId, taskId,
      leaseId: lease.leaseId, ownerId: input.ownerId,
      fencingToken: lease.fencingToken,
      executionRequestId: request.id,
      idempotencyKey, capability: request.capability,
      action: request.action, payloadDigest, payload,
    });
    if (outbox.missionId !== missionId || outbox.taskId !== taskId ||
        outbox.executionRequestId !== request.id || outbox.leaseId !== lease.leaseId ||
        outbox.fencingToken !== lease.fencingToken || outbox.idempotencyKey !== idempotencyKey ||
        outbox.payloadDigest !== payloadDigest || outbox.status !== "PENDING") {
      return { status: "ENQUEUE_RESULT_UNKNOWN", missionId, taskId };
    }
    return { status: "ENQUEUED", outbox, outboxId: outbox.outboxId, executionRequestId: request.id, idempotencyKey };
  } catch {
    // Commit may have succeeded before a transport failure. Never replay blindly.
    return { status: "ENQUEUE_RESULT_UNKNOWN", missionId, taskId };
  }
}

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

export type DurableDispatchPollResult =
  | { status: "NO_PENDING_DISPATCH" }
  | { status: "CLAIM_FAILED" | "LEASE_RENEWAL_FAILED" | "OUTCOME_PERSISTENCE_FAILED"; outboxId?: string }
  | { status: "PROCESSED"; outboxId: string; result: DispatchWorkerResult; reconciliation?: ReconciliationResult };

function decodePersistedExecutionRequest(outbox: WorkerDispatchOutbox): ExecutionRequest | null {
  const payload = outbox.payload;
  if (!payload || typeof payload !== "object" || Array.isArray(payload)) return null;
  const risk = payload.risk;
  const validRisk = risk === "LOW" || risk === "MEDIUM" || risk === "HIGH" || risk === "CRITICAL";
  if (
    payload.id !== outbox.executionRequestId ||
    payload.missionId !== outbox.missionId ||
    payload.taskId !== outbox.taskId ||
    payload.capability !== outbox.capability ||
    payload.action !== outbox.action ||
    payload.requiresApproval !== true ||
    payload.approved !== true ||
    risk !== "HIGH" ||
    !validRisk ||
    typeof payload.createdAt !== "string" ||
    !Number.isFinite(Date.parse(payload.createdAt)) ||
    !("input" in payload)
  ) return null;

  return Object.freeze({
    id: payload.id,
    missionId: payload.missionId,
    taskId: payload.taskId,
    capability: payload.capability,
    action: payload.action,
    input: payload.input,
    ...(payload.targetReference === undefined ? {} : { targetReference: payload.targetReference }),
    requiresApproval: payload.requiresApproval,
    approved: payload.approved,
    risk: risk as ExecutionRisk,
    createdAt: payload.createdAt,
  }) as ExecutionRequest;
}

/**
 * Single-iteration durable worker entry point. The server supplies a
 * server-generated ownerId; the database only returns pending outbox work
 * whose live lease is already assigned to that exact worker instance.
 *
 * This function deliberately does not poll forever. A hosting scheduler may
 * invoke it repeatedly with bounded concurrency and its own shutdown policy.
 */
export async function runNextDurableDispatch(input: {
  broker: Pick<WorkerDatabaseBroker, "claimNextDispatch" | "heartbeatLease" | "recordDispatchOutcome" | "appendReconciliationEvidence"> &
    Partial<Pick<WorkerDatabaseBroker, "claimDispatch">>;
  tenantScope: WorkerTenantScope;
  ownerId: string;
  leaseMilliseconds: number;
  identityProvider: TrustedWorkerIdentityResolver;
  provider: IdempotentDispatchProvider;
  reconciliationProvider?: ProviderStatusReader;
  /** Exact outbox created by the preceding task claim; avoids dispatching a different queue item. */
  claimedOutbox?: WorkerDispatchOutbox;
  /** Bounded provider-call deadline; defaults to the current lease duration. */
  dispatchTimeoutMilliseconds?: number;
  /** Test/hosting override. Defaults to one third of the lease duration. */
  heartbeatIntervalMilliseconds?: number;
  now?: () => number;
}): Promise<DurableDispatchPollResult> {
  if (
    typeof input.ownerId !== "string" || !input.ownerId.trim() ||
    !Number.isSafeInteger(input.leaseMilliseconds) ||
    input.leaseMilliseconds < 5_000 || input.leaseMilliseconds > 300_000 ||
    (input.dispatchTimeoutMilliseconds !== undefined &&
      (!Number.isSafeInteger(input.dispatchTimeoutMilliseconds) ||
       input.dispatchTimeoutMilliseconds < 1_000 ||
       input.dispatchTimeoutMilliseconds > 300_000)) ||
    (input.heartbeatIntervalMilliseconds !== undefined &&
      (!Number.isSafeInteger(input.heartbeatIntervalMilliseconds) ||
       input.heartbeatIntervalMilliseconds < 100 ||
       input.heartbeatIntervalMilliseconds > Math.floor(input.leaseMilliseconds / 2)))
  ) return { status: "CLAIM_FAILED" };

  let outbox: WorkerDispatchOutbox | null;
  try {
    if (input.claimedOutbox) {
      if (!input.broker.claimDispatch) return { status: "CLAIM_FAILED" };
      outbox = await input.broker.claimDispatch({
        tenantScope: input.tenantScope,
        outboxId: input.claimedOutbox.outboxId,
        leaseId: input.claimedOutbox.leaseId,
        ownerId: input.ownerId,
        fencingToken: input.claimedOutbox.fencingToken,
      });
    } else {
      outbox = await input.broker.claimNextDispatch({
        tenantScope: input.tenantScope,
        ownerId: input.ownerId,
      });
    }
  } catch {
    return { status: "CLAIM_FAILED" };
  }
  if (!outbox) return { status: "NO_PENDING_DISPATCH" };

  const request = decodePersistedExecutionRequest(outbox);
  if (!request || outbox.status !== "DISPATCHED") {
    try {
      await input.broker.recordDispatchOutcome({
        tenantScope: input.tenantScope,
        outboxId: outbox.outboxId,
        leaseId: outbox.leaseId,
        ownerId: input.ownerId,
        fencingToken: outbox.fencingToken,
        status: "RECONCILIATION_REQUIRED",
        outcome: { reason: "PERSISTED_EXECUTION_REQUEST_INVALID" },
      });
      return {
        status: "PROCESSED",
        outboxId: outbox.outboxId,
        result: { status: "RECONCILIATION_REQUIRED", reason: "PERSISTED_EXECUTION_REQUEST_INVALID" },
      };
    } catch {
      return { status: "OUTCOME_PERSISTENCE_FAILED", outboxId: outbox.outboxId };
    }
  }

  try {
    await input.broker.heartbeatLease({
      tenantScope: input.tenantScope,
      missionId: outbox.missionId,
      taskId: outbox.taskId,
      leaseId: outbox.leaseId,
      ownerId: input.ownerId,
      fencingToken: outbox.fencingToken,
      leaseMilliseconds: input.leaseMilliseconds,
    });
  } catch {
    try {
      await input.broker.recordDispatchOutcome({
        tenantScope: input.tenantScope,
        outboxId: outbox.outboxId,
        leaseId: outbox.leaseId,
        ownerId: input.ownerId,
        fencingToken: outbox.fencingToken,
        status: "RECONCILIATION_REQUIRED",
        outcome: { reason: "LEASE_RENEWAL_FAILED_BEFORE_PROVIDER_CALL" },
      });
      return {
        status: "PROCESSED",
        outboxId: outbox.outboxId,
        result: { status: "RECONCILIATION_REQUIRED", reason: "LEASE_RENEWAL_FAILED_BEFORE_PROVIDER_CALL" },
      };
    } catch {
      return { status: "LEASE_RENEWAL_FAILED", outboxId: outbox.outboxId };
    }
  }

  const dispatch: ClaimedDispatch = {
    outboxId: outbox.outboxId,
    idempotencyKey: outbox.idempotencyKey,
    executionRequestId: outbox.executionRequestId,
    leaseId: outbox.leaseId,
    ownerId: input.ownerId,
    fencingToken: outbox.fencingToken,
    request,
  };
  const recorder: DispatchOutcomeRecorder = {
    async recordOnce(item, outcome) {
      await input.broker.recordDispatchOutcome({
        tenantScope: input.tenantScope,
        outboxId: item.outboxId,
        leaseId: item.leaseId,
        ownerId: item.ownerId,
        fencingToken: item.fencingToken,
        status: outcome.status,
        outcome: outcome.outcome,
      });
    },
  };
  // Keep the lease alive while a bounded provider request is in flight.
  // A heartbeat failure or timeout is deliberately converted to an ambiguous
  // provider result: the side effect may already have happened, so never replay.
  const heartbeatInterval = input.heartbeatIntervalMilliseconds ??
    Math.max(1_000, Math.floor(input.leaseMilliseconds / 3));
  const dispatchTimeout = input.dispatchTimeoutMilliseconds ?? input.leaseMilliseconds;
  const leaseRenewingProvider: IdempotentDispatchProvider = {
    providerId: input.provider.providerId,
    supportsIdempotencyKeys: input.provider.supportsIdempotencyKeys,
    async dispatch(providerRequest, options) {
      let heartbeatFailed = false;
      let heartbeatInFlight: Promise<void> | null = null;
      const renewLease = (): Promise<void> => {
        if (heartbeatInFlight) return heartbeatInFlight;
        heartbeatInFlight = input.broker.heartbeatLease({
          tenantScope: input.tenantScope,
          missionId: outbox.missionId,
          taskId: outbox.taskId,
          leaseId: outbox.leaseId,
          ownerId: input.ownerId,
          fencingToken: outbox.fencingToken,
          leaseMilliseconds: input.leaseMilliseconds,
        }).then(() => undefined).catch(() => {
          heartbeatFailed = true;
        }).finally(() => {
          heartbeatInFlight = null;
        });
        return heartbeatInFlight;
      };
      const heartbeatTimer = setInterval(() => {
        void renewLease();
      }, heartbeatInterval);
      let timeoutHandle: ReturnType<typeof setTimeout> | undefined;
      try {
        const timeout = new Promise<never>((_resolve, reject) => {
          timeoutHandle = setTimeout(
            () => reject(new Error("PROVIDER_DISPATCH_TIMEOUT")),
            dispatchTimeout,
          );
        });
        const observation = await Promise.race([
          input.provider.dispatch(providerRequest, options),
          timeout,
        ]);
        if (heartbeatInFlight) await heartbeatInFlight;
        if (heartbeatFailed) throw new Error("LEASE_HEARTBEAT_FAILED_DURING_PROVIDER_CALL");
        return observation;
      } finally {
        clearInterval(heartbeatTimer);
        if (timeoutHandle) clearTimeout(timeoutHandle);
        if (heartbeatInFlight) await heartbeatInFlight;
      }
    },
  };

  let result: DispatchWorkerResult;
  try {
    result = await dispatchWithTrustedWorkerIdentity(
      input.identityProvider,
      dispatch,
      leaseRenewingProvider,
      recorder,
      input.now,
    );
  } catch {
    result = { status: "RECONCILIATION_REQUIRED", reason: "WORKER_DISPATCH_RUNTIME_FAILED" };
  }

  // Identity/capability/provider-contract rejection happens before a provider
  // call. Persist that terminal routing decision so DISPATCHED rows do not
  // remain indefinitely ambiguous merely because the worker could not start.
  if (result.status === "RECONCILIATION_REQUIRED") {
    try {
      await input.broker.recordDispatchOutcome({
        tenantScope: input.tenantScope,
        outboxId: outbox.outboxId,
        leaseId: outbox.leaseId,
        ownerId: input.ownerId,
        fencingToken: outbox.fencingToken,
        status: "RECONCILIATION_REQUIRED",
        outcome: { reason: result.reason },
      });
    } catch {
      return { status: "OUTCOME_PERSISTENCE_FAILED", outboxId: outbox.outboxId };
    }
  }

  let reconciliation: ReconciliationResult | undefined;
  if (
    input.reconciliationProvider &&
    result.status === "RECORDED" &&
    (result.outcome === "AMBIGUOUS" || result.outcome === "RECONCILIATION_REQUIRED")
  ) {
    if (input.reconciliationProvider.providerId !== input.provider.providerId) {
      // Never look up an idempotency key against a different provider account.
      reconciliation = {
        status: "RECONCILIATION_REQUIRED",
        reason: "RECONCILIATION_PROVIDER_MISMATCH",
      };
    } else {
      const evidenceStore: ProviderReconciliationEvidenceStore = {
        async append(evidence) {
          await input.broker.appendReconciliationEvidence({
            tenantScope: input.tenantScope,
            outboxId: evidence.outboxId,
            evidenceId: crypto.randomUUID(),
            idempotencyKey: evidence.idempotencyKey,
            providerId: evidence.providerId,
            observedAt: evidence.observedAt,
            status: evidence.observation.status,
            observation: { ...evidence.observation },
          });
        },
      };
      const observedAtMs = (input.now ?? Date.now)();
      if (!Number.isFinite(observedAtMs) || observedAtMs < 0) {
        reconciliation = { status: "RECONCILIATION_REQUIRED", reason: "RECONCILIATION_CLOCK_UNAVAILABLE" };
      } else {
        reconciliation = await reconcileProviderDispatch(
          {
            outboxId: outbox.outboxId,
            idempotencyKey: outbox.idempotencyKey,
            providerId: input.provider.providerId,
            originalOutcome: result.outcome,
          },
          input.reconciliationProvider,
          evidenceStore,
          new Date(observedAtMs).toISOString(),
        );
      }
    }
  }
  return {
    status: "PROCESSED",
    outboxId: outbox.outboxId,
    result,
    ...(reconciliation ? { reconciliation } : {}),
  };
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
