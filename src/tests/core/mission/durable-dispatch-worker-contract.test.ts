import type { ExecutionRequest } from "../../../core/execution/types";
import {
  dispatchClaimedOutboxItem,
  type ClaimedDispatch,
  type DispatchOutcomeRecorder,
  type IdempotentDispatchProvider,
  type PersistedDispatchOutcome,
} from "../../../core/mission/durable-dispatch-worker-contract";
import type { WorkerIdentityResolution } from "../../../core/mission/trusted-worker-identity";

const request: ExecutionRequest = {
  id: "request-1", missionId: "mission-1", taskId: "task-1",
  capability: "API", action: "POST", input: { value: 1 },
  requiresApproval: false, approved: false, risk: "LOW",
  createdAt: "2026-11-21T10:00:00.000Z",
};
const dispatch: ClaimedDispatch = {
  outboxId: "outbox-1", idempotencyKey: "tenant-key-1",
  executionRequestId: request.id, leaseId: "lease-1",
  ownerId: "worker-1", fencingToken: 4, request,
};
const workerNow = Math.floor(Date.now() / 1000);
const workerIdentity: WorkerIdentityResolution = {
  status: "VERIFIED",
  identity: {
    principal: "worker-1",
    issuer: "https://identity.example.test",
    audience: "happy-execution",
    environment: "staging",
    tokenId: "token-unique-1",
    issuedAt: workerNow - 30,
    expiresAt: workerNow + 240,
    capabilities: ["API"],
  },
};

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function recorderFor(
  record: (item: ClaimedDispatch, outcome: PersistedDispatchOutcome) => Promise<void>,
): DispatchOutcomeRecorder {
  return { recordOnce: record };
}

async function run(): Promise<void> {
  let providerCalls = 0;
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

  let identityMismatchCalls = 0;
  const wrongPrincipal: WorkerIdentityResolution = {
    ...workerIdentity,
    identity: { ...workerIdentity.identity, principal: "workload:other" },
  };
  const deniedIdentity = await dispatchClaimedOutboxItem(
    dispatch, wrongPrincipal,
    { ...provider, async dispatch() { identityMismatchCalls += 1; return { kind: "ACKNOWLEDGED" as const, provider: "x", providerRequestId: "x", response: null }; } },
    recorderFor(async () => {}),
  );
  assert(deniedIdentity.status === "RECONCILIATION_REQUIRED" && identityMismatchCalls === 0,
    "worker principal mismatch reached provider");

  const missingCapability: WorkerIdentityResolution = {
    ...workerIdentity,
    identity: { ...workerIdentity.identity, capabilities: ["VERIFY"] },
  };
  const deniedCapability = await dispatchClaimedOutboxItem(
    dispatch, missingCapability, provider, recorderFor(async () => {}),
  );
  assert(deniedCapability.status === "RECONCILIATION_REQUIRED" && providerCalls === 1,
    "worker without the request capability reached provider");

  const disconnected = await dispatchClaimedOutboxItem(
    dispatch, { status: "NOT_CONNECTED" }, provider, recorderFor(async () => {}),
  );
  assert(disconnected.status === "RECONCILIATION_REQUIRED" && providerCalls === 1,
    "unconnected worker identity reached provider");

  const expiredIdentity: WorkerIdentityResolution = {
    ...workerIdentity,
    identity: { ...workerIdentity.identity, expiresAt: workerNow - 1 },
  };
  const expired = await dispatchClaimedOutboxItem(
    dispatch, expiredIdentity, provider, recorderFor(async () => {}), () => workerNow * 1000,
  );
  assert(expired.status === "RECONCILIATION_REQUIRED" && providerCalls === 1,
    "expired worker identity reached provider");

  const unavailableClock = await dispatchClaimedOutboxItem(
    dispatch, workerIdentity, provider, recorderFor(async () => {}), () => Number.NaN,
  );
  assert(unavailableClock.status === "RECONCILIATION_REQUIRED" && providerCalls === 1,
    "invalid worker clock reached provider");

  console.log("Durable dispatch worker contract tests: PASS");
}

void run();
