import type { ExecutionRequest } from "../../../core/execution/types";
import type {
  WorkerDatabaseBroker,
  WorkerDispatchOutbox,
  WorkerTenantScope,
} from "../../../core/mission/worker-database-broker";
import {
  claimAndEnqueueApprovedTask,
  dispatchClaimedOutboxItem,
  dispatchWithTrustedWorkerIdentity,
  runNextDurableDispatch,
  type ClaimedDispatch,
  type DispatchOutcomeRecorder,
  type IdempotentDispatchProvider,
  type PersistedDispatchOutcome,
} from "../../../core/mission/durable-dispatch-worker-contract";
import {
  TrustedWorkerIdentityProvider,
  type VerifiedWorkerCredentialClaims,
  type WorkerIdentityResolution,
} from "../../../core/mission/trusted-worker-identity";

const request: ExecutionRequest = {
  id: "request-1", missionId: "mission-1", taskId: "task-1",
  capability: "API", action: "POST", input: { value: 1 },
  requiresApproval: false, approved: false, risk: "LOW",
  createdAt: "2026-11-21T10:00:00.000Z",
};
const dispatch: ClaimedDispatch = {
  outboxId: "outbox-1", idempotencyKey: "tenant-key-1",
  executionRequestId: request.id, leaseId: "lease-1",
  // The lease owner is a server-generated worker-instance ID, not the OIDC subject.
  ownerId: "worker-instance-42", fencingToken: 4, request,
};
const workerNow = Math.floor(Date.now() / 1000);
const identityPolicy = {
  issuer: "https://identity.example.test",
  audience: "happy-execution",
  environment: "staging",
  allowedSubjects: ["owner:team:project:happy-worker:environment:staging", "owner:team:project:other-worker:environment:staging"],
  allowedCapabilities: ["API", "VERIFY"] as const,
  maxCredentialLifetimeSeconds: 300,
  clockSkewSeconds: 15,
};

async function resolveWorkerIdentity(
  patch: Partial<VerifiedWorkerCredentialClaims> = {},
): Promise<WorkerIdentityResolution> {
  const claims: VerifiedWorkerCredentialClaims = {
    issuer: identityPolicy.issuer,
    subject: "owner:team:project:happy-worker:environment:staging",
    audience: identityPolicy.audience,
    issuedAt: workerNow - 30,
    notBefore: workerNow - 30,
    expiresAt: workerNow + 240,
    tokenId: "token-unique-1",
    environment: identityPolicy.environment,
    capabilities: ["API"],
    ...patch,
  };
  return new TrustedWorkerIdentityProvider(
    { async getCredential() { return "opaque-platform-credential"; } },
    { async verifyCredential() { return claims; } },
    {
      ...identityPolicy,
      allowedCapabilities: [...identityPolicy.allowedCapabilities],
    },
    () => workerNow * 1000,
  ).getVerifiedWorkerIdentity();
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function recorderFor(
  record: (item: ClaimedDispatch, outcome: PersistedDispatchOutcome) => Promise<void>,
): DispatchOutcomeRecorder {
  return { recordOnce: record };
}

async function run(): Promise<void> {
  const workerIdentity = await resolveWorkerIdentity();
  assert(workerIdentity.status === "VERIFIED", "test workload identity was not verified");

  let providerCalls = 0;
  const getProviderCallCount = () => providerCalls;
  let persisted: PersistedDispatchOutcome | undefined;
  const provider: IdempotentDispatchProvider = {
    providerId: "provider-a",
    supportsIdempotencyKeys: true,
    async dispatch(_request, options) {
      providerCalls += 1;
      assert(options.idempotencyKey === dispatch.idempotencyKey, "stable idempotency key was not forwarded");
      return { kind: "ACKNOWLEDGED", provider: "provider-a", providerRequestId: "remote-1", response: { ok: true } };
    },
  };
  const success = await dispatchClaimedOutboxItem(
    dispatch, workerIdentity, provider,
    recorderFor(async (_item, outcome) => { persisted = outcome; }),
  );
  assert(success.status === "RECORDED" && success.outcome === "ACKNOWLEDGED", "acknowledged provider result was not recorded");
  assert(providerCalls === 1 && persisted?.status === "ACKNOWLEDGED", "provider call/result persistence mismatch");

  let identityReads = 0;
  const freshIdentityDispatch = await dispatchWithTrustedWorkerIdentity(
    { async getVerifiedWorkerIdentity() { identityReads += 1; return workerIdentity; } },
    dispatch,
    provider,
    recorderFor(async () => {}),
  );
  assert(freshIdentityDispatch.status === "RECORDED" && identityReads === 1,
    "dispatch must resolve a fresh workload identity for each item");

  const unavailableIdentityDispatch = await dispatchWithTrustedWorkerIdentity(
    { async getVerifiedWorkerIdentity() { return { status: "NOT_CONNECTED" }; } },
    dispatch,
    provider,
    recorderFor(async () => {}),
  );
  assert(unavailableIdentityDispatch.status === "RECONCILIATION_REQUIRED" && getProviderCallCount() === 2,
    "missing worker identity must not call the provider");

  const failedIdentityDispatch = await dispatchWithTrustedWorkerIdentity(
    { async getVerifiedWorkerIdentity() { throw new Error("credential source unavailable"); } },
    dispatch,
    provider,
    recorderFor(async () => {}),
  );
  assert(failedIdentityDispatch.status === "RECONCILIATION_REQUIRED" && getProviderCallCount() === 2,
    "worker identity provider failure must not call the provider");

  let unsafeCalls = 0;
  const unsafeProvider = {
    providerId: "provider-without-dedupe",
    supportsIdempotencyKeys: false,
    async dispatch() { unsafeCalls += 1; return { kind: "ACKNOWLEDGED" as const, provider: "x", providerRequestId: "x", response: null }; },
  };
  const unsafe = await dispatchClaimedOutboxItem(
    dispatch, workerIdentity, unsafeProvider as unknown as IdempotentDispatchProvider,
    recorderFor(async () => {}),
  );
  assert(unsafe.status === "RECONCILIATION_REQUIRED" && unsafeCalls === 0, "non-idempotent provider was invoked");

  let ambiguous: PersistedDispatchOutcome | undefined;
  const throwingProvider: IdempotentDispatchProvider = {
    providerId: "provider-b",
    supportsIdempotencyKeys: true,
    async dispatch() { throw new Error("socket closed after request write"); },
  };
  const unknown = await dispatchClaimedOutboxItem(
    dispatch, workerIdentity, throwingProvider,
    recorderFor(async (_item, outcome) => { ambiguous = outcome; }),
  );
  assert(unknown.status === "RECORDED" && ambiguous?.status === "AMBIGUOUS", "transport failure was incorrectly treated as definitive failure");

  let retryCalls = 0;
  const persistenceFailure = await dispatchClaimedOutboxItem(
    dispatch,
    workerIdentity,
    { ...provider, async dispatch() { retryCalls += 1; return { kind: "ACKNOWLEDGED" as const, provider: "provider-a", providerRequestId: "remote-2", response: {} }; } },
    recorderFor(async () => { throw new Error("database unavailable"); }),
  );
  assert(persistenceFailure.status === "OUTCOME_PERSISTENCE_FAILED" && retryCalls === 1, "persistence failure must not trigger provider replay");

  let invalidCalls = 0;
  const invalid = await dispatchClaimedOutboxItem(
    { ...dispatch, executionRequestId: "different-request" },
    workerIdentity,
    { ...provider, async dispatch() { invalidCalls += 1; return { kind: "ACKNOWLEDGED" as const, provider: "provider-a", providerRequestId: "x", response: {} }; } },
    recorderFor(async () => {}),
  );
  assert(invalid.status === "RECONCILIATION_REQUIRED" && invalidCalls === 0, "mismatched request binding reached provider");

  // A workload identity and a worker-instance lease owner are distinct identities.
  // The guarded broker and database principal registry authorize the workload;
  // the owner ID only fences a specific worker instance's lease.
  const differentInstanceOwner = await dispatchClaimedOutboxItem(
    { ...dispatch, ownerId: "worker-instance-99" },
    workerIdentity,
    {
      providerId: "provider-instance-test",
      supportsIdempotencyKeys: true,
      async dispatch() {
        return { kind: "ACKNOWLEDGED" as const, provider: "provider-instance-test", providerRequestId: "instance-test", response: {} };
      },
    },
    recorderFor(async () => {}),
  );
  assert(differentInstanceOwner.status === "RECORDED",
    "a valid workload identity must not be conflated with the per-instance lease owner");

  const missingCapability = await resolveWorkerIdentity({ capabilities: ["VERIFY"] });
  const deniedCapability = await dispatchClaimedOutboxItem(
    dispatch, missingCapability, provider, recorderFor(async () => {}),
  );
  assert(deniedCapability.status === "RECONCILIATION_REQUIRED" && getProviderCallCount() === 2,
    "worker without the request capability reached provider");

  const disconnected = await dispatchClaimedOutboxItem(
    dispatch, { status: "NOT_CONNECTED" }, provider, recorderFor(async () => {}),
  );
  assert(disconnected.status === "RECONCILIATION_REQUIRED" && getProviderCallCount() === 2,
    "unconnected worker identity reached provider");

  const expiringIdentity = await resolveWorkerIdentity({ expiresAt: workerNow + 1 });
  const expired = await dispatchClaimedOutboxItem(
    dispatch, expiringIdentity, provider, recorderFor(async () => {}), () => (workerNow + 1) * 1000,
  );
  assert(expired.status === "RECONCILIATION_REQUIRED" && getProviderCallCount() === 2,
    "expired worker identity reached provider");

  const unavailableClock = await dispatchClaimedOutboxItem(
    dispatch, workerIdentity, provider, recorderFor(async () => {}), () => Number.NaN,
  );
  assert(unavailableClock.status === "RECONCILIATION_REQUIRED" && getProviderCallCount() === 2,
    "invalid worker clock reached provider");

  const forged = {
    status: "VERIFIED" as const,
    identity: { ...workerIdentity.identity, principal: "owner:team:project:happy-worker:environment:staging" },
  } as unknown as WorkerIdentityResolution;
  const forgedResult = await dispatchClaimedOutboxItem(
    dispatch, forged, provider, recorderFor(async () => {}),
  );
  assert(forgedResult.status === "RECONCILIATION_REQUIRED" && getProviderCallCount() === 2,
    "structurally forged identity object reached provider");

  const tenantScope: WorkerTenantScope = {
    workerPrincipalId: "worker-principal-1",
    organizationId: "org-1",
    workspaceId: "workspace-1",
    userId: "user-1",
  };
  const queuedOutbox: WorkerDispatchOutbox = {
    outboxId: "outbox-durable-1",
    organizationId: tenantScope.organizationId,
    workspaceId: tenantScope.workspaceId,
    userId: tenantScope.userId,
    missionId: "mission-durable-1",
    taskId: "task-durable-1",
    leaseId: "lease-durable-1",
    fencingToken: 9,
    attempt: 1,
    executionRequestId: "request-durable-1",
    idempotencyKey: "durable-idempotency-1",
    capability: "API",
    action: "POST",
    payloadDigest: "sha256:" + "b".repeat(64),
    payload: {
      id: "request-durable-1",
      missionId: "mission-durable-1",
      taskId: "task-durable-1",
      capability: "API",
      action: "POST",
      input: { value: "approved" },
      requiresApproval: true,
      approved: true,
      risk: "HIGH",
      createdAt: "2026-11-21T10:00:00.000Z",
    },
    outcome: {},
    status: "DISPATCHED",
    createdAt: "2026-11-21T10:00:00.000Z",
    updatedAt: "2026-11-21T10:00:01.000Z",
  };
  const approvedExecutionRequest: ExecutionRequest = {
    id: "request-approved-task-1",
    missionId: "mission-durable-1",
    taskId: "task-durable-1",
    capability: "API",
    action: "POST",
    input: { value: "approved-task" },
    requiresApproval: true,
    approved: true,
    risk: "HIGH",
    createdAt: "2026-11-21T10:00:00.000Z",
  };
  let taskClaimCalls = 0;
  let taskLeaseHeartbeatCalls = 0;
  let taskEnqueueCalls = 0;
  const taskEnqueue = await claimAndEnqueueApprovedTask({
    tenantScope,
    missionId: approvedExecutionRequest.missionId,
    taskId: approvedExecutionRequest.taskId,
    ownerId: "worker-instance-42",
    leaseMilliseconds: 30_000,
    broker: {
      async claimTask() {
        taskClaimCalls += 1;
        return {
          leaseId: "task-lease-1",
          attempt: 1,
          fencingToken: 3,
          expiresAt: "2026-11-21T10:05:00.000Z",
          taskVersion: 12,
          executionRequest: approvedExecutionRequest,
        };
      },
      async heartbeatLease() {
        taskLeaseHeartbeatCalls += 1;
        return "2026-11-21T10:05:30.000Z";
      },
      async enqueueDispatch(input) {
        taskEnqueueCalls += 1;
        return {
          ...queuedOutbox,
          outboxId: "outbox-approved-task-1",
          missionId: input.missionId,
          taskId: input.taskId,
          leaseId: input.leaseId,
          fencingToken: input.fencingToken,
          executionRequestId: input.executionRequestId,
          idempotencyKey: input.idempotencyKey,
          capability: input.capability,
          action: input.action,
          payloadDigest: input.payloadDigest,
          payload: { ...input.payload },
          status: "PENDING" as const,
        };
      },
    },
  });
  assert(taskEnqueue.status === "ENQUEUED" &&
    taskEnqueue.executionRequestId === approvedExecutionRequest.id &&
    taskClaimCalls === 1 && taskLeaseHeartbeatCalls === 1 && taskEnqueueCalls === 1,
  "approved task claim must bind its verified request, renew the lease and enqueue exactly once");

  let unapprovedEnqueueCalls = 0;
  const unapprovedTask = await claimAndEnqueueApprovedTask({
    tenantScope,
    missionId: approvedExecutionRequest.missionId,
    taskId: approvedExecutionRequest.taskId,
    ownerId: "worker-instance-42",
    leaseMilliseconds: 30_000,
    broker: {
      async claimTask() {
        return {
          leaseId: "task-lease-unapproved",
          attempt: 1,
          fencingToken: 1,
          expiresAt: "2026-11-21T10:05:00.000Z",
          taskVersion: 13,
          executionRequest: { ...approvedExecutionRequest, approved: false },
        };
      },
      async heartbeatLease() { return "2026-11-21T10:05:30.000Z"; },
      async enqueueDispatch() {
        unapprovedEnqueueCalls += 1;
        return queuedOutbox;
      },
    },
  });
  assert(unapprovedTask.status === "APPROVED_REQUEST_INVALID" && unapprovedEnqueueCalls === 0,
    "an unapproved execution envelope must never reach dispatch enqueue");

  let heartbeatCalls = 0;
  let outcomeCalls = 0;
  const durableBroker: Pick<WorkerDatabaseBroker, "claimNextDispatch" | "heartbeatLease" | "recordDispatchOutcome" | "appendReconciliationEvidence"> = {
    async claimNextDispatch(input: { tenantScope: WorkerTenantScope; ownerId: string }) {
      assert(input.ownerId === "worker-instance-42", "queue claim must use the server-owned worker instance ID");
      return queuedOutbox;
    },
    async heartbeatLease() {
      heartbeatCalls += 1;
      return "2026-11-21T10:05:00.000Z";
    },
    async recordDispatchOutcome(
      input: Parameters<WorkerDatabaseBroker["recordDispatchOutcome"]>[0],
    ): Promise<WorkerDispatchOutbox> {
      outcomeCalls += 1;
      return { ...queuedOutbox, status: input.status, outcome: { ...input.outcome } };
    },
    async appendReconciliationEvidence() {
      throw new Error("acknowledged dispatch must not be reconciled");
    },
  };
  let durableProviderCalls = 0;
  const durableResult = await runNextDurableDispatch({
    broker: durableBroker,
    tenantScope,
    ownerId: "worker-instance-42",
    leaseMilliseconds: 30_000,
    identityProvider: { async getVerifiedWorkerIdentity() { return workerIdentity; } },
    provider: {
      providerId: "durable-provider",
      supportsIdempotencyKeys: true,
      async dispatch(_request, options) {
        durableProviderCalls += 1;
        assert(options.idempotencyKey === queuedOutbox.idempotencyKey,
          "durable worker must preserve the persisted idempotency key");
        return {
          kind: "ACKNOWLEDGED",
          provider: "durable-provider",
          providerRequestId: "durable-remote-1",
          response: { accepted: true },
        };
      },
    },
    now: () => workerNow * 1000,
  });
  assert(
    durableResult.status === "PROCESSED" &&
    durableResult.result.status === "RECORDED" &&
    durableResult.result.outcome === "ACKNOWLEDGED",
    "durable worker must claim, renew, execute and persist an acknowledged result",
  );
  assert(heartbeatCalls === 1 && outcomeCalls === 1 && durableProviderCalls === 1,
    "durable worker lifecycle must heartbeat and persist exactly once");

  // A slow provider call must keep renewing its lease while it is in flight.
  let slowHeartbeatCalls = 0;
  let slowOutcome: PersistedDispatchOutcome | undefined;
  const slowRun = await runNextDurableDispatch({
    broker: {
      async claimNextDispatch() { return queuedOutbox; },
      async heartbeatLease() {
        slowHeartbeatCalls += 1;
        return "2026-11-21T10:05:00.000Z";
      },
      async recordDispatchOutcome(input) {
        slowOutcome = { status: input.status, outcome: { ...input.outcome } };
        return { ...queuedOutbox, status: input.status, outcome: { ...input.outcome } };
      },
      async appendReconciliationEvidence() { return "unused"; },
    },
    tenantScope,
    ownerId: "worker-instance-42",
    leaseMilliseconds: 5_000,
    heartbeatIntervalMilliseconds: 100,
    dispatchTimeoutMilliseconds: 2_000,
    identityProvider: { async getVerifiedWorkerIdentity() { return workerIdentity; } },
    provider: {
      providerId: "slow-provider",
      supportsIdempotencyKeys: true,
      async dispatch() {
        await new Promise((resolve) => setTimeout(resolve, 260));
        return { kind: "ACKNOWLEDGED", provider: "slow-provider", providerRequestId: "slow-remote-1", response: {} };
      },
    },
  });
  assert(slowRun.status === "PROCESSED" && slowRun.result.status === "RECORDED" &&
    slowRun.result.outcome === "ACKNOWLEDGED" && slowHeartbeatCalls >= 2,
  "long-running provider call did not renew its lease while in flight");
  assert(slowOutcome?.status === "ACKNOWLEDGED",
    "long-running provider acknowledgement was not persisted");

  // A heartbeat failure during a provider call makes its result ambiguous;
  // the provider may have completed, so the worker must not report success.
  let failingHeartbeatCalls = 0;
  let heartbeatFailureOutcome: PersistedDispatchOutcome | undefined;
  const heartbeatFailureRun = await runNextDurableDispatch({
    broker: {
      async claimNextDispatch() { return queuedOutbox; },
      async heartbeatLease() {
        failingHeartbeatCalls += 1;
        if (failingHeartbeatCalls > 1) throw new Error("lease heartbeat unavailable");
        return "2026-11-21T10:05:00.000Z";
      },
      async recordDispatchOutcome(input) {
        heartbeatFailureOutcome = { status: input.status, outcome: { ...input.outcome } };
        return { ...queuedOutbox, status: input.status, outcome: { ...input.outcome } };
      },
      async appendReconciliationEvidence() { return "unused"; },
    },
    tenantScope,
    ownerId: "worker-instance-42",
    leaseMilliseconds: 5_000,
    heartbeatIntervalMilliseconds: 100,
    dispatchTimeoutMilliseconds: 2_000,
    identityProvider: { async getVerifiedWorkerIdentity() { return workerIdentity; } },
    provider: {
      providerId: "heartbeat-failure-provider",
      supportsIdempotencyKeys: true,
      async dispatch() {
        await new Promise((resolve) => setTimeout(resolve, 260));
        return { kind: "ACKNOWLEDGED", provider: "heartbeat-failure-provider", providerRequestId: "late-remote-1", response: {} };
      },
    },
  });
  assert(heartbeatFailureRun.status === "PROCESSED" &&
    heartbeatFailureRun.result.status === "RECORDED" &&
    heartbeatFailureRun.result.outcome === "AMBIGUOUS" &&
    heartbeatFailureOutcome?.status === "AMBIGUOUS",
  "lease heartbeat failure was not converted to an ambiguous, non-replayable outcome");

  const exactOutbox = { ...queuedOutbox, outboxId: "outbox-exact-claim-1", status: "PENDING" as const };
  let exactClaimDispatchCalls = 0;
  let accidentalNextClaimCalls = 0;
  const exactOutboxRun = await runNextDurableDispatch({
    broker: {
      async claimNextDispatch() {
        accidentalNextClaimCalls += 1;
        throw new Error("exact task dispatch must not claim a different queue item");
      },
      async claimDispatch(input) {
        exactClaimDispatchCalls += 1;
        assert(input.outboxId === exactOutbox.outboxId &&
          input.leaseId === exactOutbox.leaseId &&
          input.fencingToken === exactOutbox.fencingToken,
        "exact outbox claim must preserve lease and fencing bindings");
        return { ...exactOutbox, status: "DISPATCHED" as const };
      },
      async heartbeatLease() { return "2026-11-21T10:05:00.000Z"; },
      async recordDispatchOutcome(input) {
        return { ...exactOutbox, status: input.status, outcome: { ...input.outcome } };
      },
      async appendReconciliationEvidence() { return "unused"; },
    },
    tenantScope,
    ownerId: "worker-instance-42",
    leaseMilliseconds: 30_000,
    claimedOutbox: exactOutbox,
    identityProvider: { async getVerifiedWorkerIdentity() { return workerIdentity; } },
    provider: {
      providerId: "exact-outbox-provider",
      supportsIdempotencyKeys: true,
      async dispatch() {
        return { kind: "ACKNOWLEDGED", provider: "exact-outbox-provider", providerRequestId: "exact-remote-1", response: {} };
      },
    },
  });
  assert(exactOutboxRun.status === "PROCESSED" &&
    exactOutboxRun.result.status === "RECORDED" &&
    exactClaimDispatchCalls === 1 && accidentalNextClaimCalls === 0,
  "mission task worker must dispatch the exact outbox row it just enqueued");

  let reconciliationEvidenceCalls = 0;
  const ambiguousOutbox = { ...queuedOutbox, outboxId: "outbox-ambiguous-1", idempotencyKey: "ambiguous-key-1" };
  const ambiguousBroker: Pick<WorkerDatabaseBroker, "claimNextDispatch" | "heartbeatLease" | "recordDispatchOutcome" | "appendReconciliationEvidence"> = {
    async claimNextDispatch() { return ambiguousOutbox; },
    async heartbeatLease() { return "2026-11-21T10:05:00.000Z"; },
    async recordDispatchOutcome(input) {
      return { ...ambiguousOutbox, status: input.status, outcome: { ...input.outcome } };
    },
    async appendReconciliationEvidence(input) {
      reconciliationEvidenceCalls += 1;
      assert(input.outboxId === ambiguousOutbox.outboxId &&
        input.idempotencyKey === ambiguousOutbox.idempotencyKey &&
        input.status === "SUCCEEDED",
      "reconciliation evidence must remain bound to the claimed outbox and idempotency key");
      return input.evidenceId;
    },
  };
  const ambiguousRun = await runNextDurableDispatch({
    broker: ambiguousBroker,
    tenantScope,
    ownerId: "worker-instance-42",
    leaseMilliseconds: 30_000,
    identityProvider: { async getVerifiedWorkerIdentity() { return workerIdentity; } },
    provider: {
      providerId: "durable-provider",
      supportsIdempotencyKeys: true,
      async dispatch() { throw new Error("transport closed after provider accepted request"); },
    },
    reconciliationProvider: {
      providerId: "durable-provider",
      supportsIdempotencyKeys: true,
      async lookupByIdempotencyKey() {
        return { status: "SUCCEEDED", providerRequestId: "remote-ambiguous-1", result: { accepted: true } };
      },
    },
    now: () => workerNow * 1000,
  });
  assert(ambiguousRun.status === "PROCESSED" &&
    ambiguousRun.result.status === "RECORDED" &&
    ambiguousRun.result.outcome === "AMBIGUOUS" &&
    ambiguousRun.reconciliation?.status === "RECORDED" &&
    ambiguousRun.reconciliation.decision.status === "VERIFICATION_REQUIRED",
  "ambiguous provider result must trigger read-only reconciliation and persist evidence");
  assert(reconciliationEvidenceCalls === 1,
    "provider reconciliation must append exactly one immutable evidence record");

  const emptyQueueResult = await runNextDurableDispatch({
    broker: {
      async claimNextDispatch() { return null; },
      async heartbeatLease() { throw new Error("must not heartbeat an empty queue"); },
      async recordDispatchOutcome() { throw new Error("must not record an empty queue"); },
      async appendReconciliationEvidence() { throw new Error("must not reconcile an empty queue"); },
    },
    tenantScope,
    ownerId: "worker-instance-42",
    leaseMilliseconds: 30_000,
    identityProvider: { async getVerifiedWorkerIdentity() { return workerIdentity; } },
    provider,
  });
  assert(emptyQueueResult.status === "NO_PENDING_DISPATCH",
    "durable worker must report an empty queue without executing a provider");

  console.log("Durable dispatch worker contract tests: PASS");
}

void run();
