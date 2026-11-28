import {
  reconcileProviderDispatch,
  type ProviderReconciliationEvidence,
  type ProviderReconciliationEvidenceStore,
  type ProviderStatusReader,
} from "../../../core/mission/provider-dispatch-reconciliation";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const target = {
  outboxId: "outbox-1",
  idempotencyKey: "tenant-key-1",
  providerId: "provider-a",
  originalOutcome: "AMBIGUOUS" as const,
};
async function main(): Promise<void> {
  let lookups = 0;
  const evidence: ProviderReconciliationEvidence[] = [];
  const store: ProviderReconciliationEvidenceStore = {
    async append(item) { evidence.push(item); },
  };
  const succeeded: ProviderStatusReader = {
    providerId: "provider-a",
    supportsIdempotencyKeys: true,
    async lookupByIdempotencyKey(key) {
      lookups++;
      assert(key === target.idempotencyKey, "lookup must use original idempotency key");
      return { status: "SUCCEEDED", providerRequestId: "remote-1", result: { ok: true } };
    },
  };
  const result = await reconcileProviderDispatch(target, succeeded, store, "2026-11-21T10:00:00.000Z");
  assert(result.status === "RECORDED" && result.decision.status === "VERIFICATION_REQUIRED", "success must route to verification");
  assert(lookups === 1 && evidence.length === 1, "provider observation must be appended once");

  const missing = await reconcileProviderDispatch(target, {
    ...succeeded,
    async lookupByIdempotencyKey() { return { status: "NOT_FOUND" }; },
  }, store);
  assert(missing.status === "RECORDED" && missing.decision.status === "NO_PROVIDER_RECORD_REVIEW_REQUIRED", "not-found must require review, not replay");

  const processing = await reconcileProviderDispatch(target, {
    ...succeeded,
    async lookupByIdempotencyKey() { return { status: "PROCESSING", providerRequestId: "remote-2" }; },
  }, store);
  assert(processing.status === "RECORDED" && processing.decision.status === "PROVIDER_STILL_PROCESSING", "processing status was not preserved");

  const failed = await reconcileProviderDispatch(target, {
    ...succeeded,
    async lookupByIdempotencyKey() { return { status: "FAILED", providerRequestId: "remote-3", code: "DECLINED", message: "Rejected" }; },
  }, store);
  assert(failed.status === "RECORDED" && failed.decision.status === "FAILED_EXECUTION_REVIEW_REQUIRED", "provider failure must route to review");

  let unsafeLookups = 0;
  const unsafe = await reconcileProviderDispatch(target, {
    providerId: "provider-a",
    supportsIdempotencyKeys: false,
    async lookupByIdempotencyKey() { unsafeLookups++; return { status: "NOT_FOUND" }; },
  } as unknown as ProviderStatusReader, store);
  assert(unsafe.status === "RECONCILIATION_REQUIRED" && unsafeLookups === 0, "unsupported provider must not be queried");

  const lookupFailure = await reconcileProviderDispatch(target, {
    ...succeeded,
    async lookupByIdempotencyKey() { throw new Error("timeout"); },
  }, store);
  assert(lookupFailure.status === "RECONCILIATION_REQUIRED", "lookup failure must remain unresolved");

  const persistenceFailure = await reconcileProviderDispatch(target, succeeded, {
    async append() { throw new Error("storage unavailable"); },
  });
  assert(persistenceFailure.status === "EVIDENCE_PERSISTENCE_FAILED", "failed evidence append must not report reconciliation recorded");


  let malformedLookups = 0;
  const malformed = await reconcileProviderDispatch(target, {
    ...succeeded,
    async lookupByIdempotencyKey() {
      malformedLookups++;
      return { status: "SUCCEEDED", providerRequestId: 17, result: null } as unknown as Awaited<ReturnType<ProviderStatusReader["lookupByIdempotencyKey"]>>;
    },
  }, store);
  assert(malformed.status === "RECONCILIATION_REQUIRED" && malformedLookups === 1, "malformed provider identity must not be accepted");

  let invalidTimestampLookups = 0;
  const invalidTimestamp = await reconcileProviderDispatch(target, {
    ...succeeded,
    async lookupByIdempotencyKey() {
      invalidTimestampLookups++;
      return { status: "NOT_FOUND" };
    },
  }, store, "not-a-timestamp");
  assert(invalidTimestamp.status === "RECONCILIATION_REQUIRED" && invalidTimestampLookups === 0, "invalid evidence timestamp must be rejected before provider lookup");

  const unknownStatus = await reconcileProviderDispatch(target, {
    ...succeeded,
    async lookupByIdempotencyKey() {
      return { status: "MAGIC_SUCCESS" } as unknown as Awaited<ReturnType<ProviderStatusReader["lookupByIdempotencyKey"]>>;
    },
  }, store);
  assert(unknownStatus.status === "RECONCILIATION_REQUIRED", "unrecognized provider status must not be persisted as success");

  const nullTarget = await reconcileProviderDispatch(null as never, succeeded, store);
  assert(nullTarget.status === "RECONCILIATION_REQUIRED", "null target must fail closed");

  const malformedFailure = await reconcileProviderDispatch(target, {
    ...succeeded,
    async lookupByIdempotencyKey() {
      return { status: "FAILED", providerRequestId: "remote-bad", code: 9, message: "bad" } as unknown as Awaited<ReturnType<ProviderStatusReader["lookupByIdempotencyKey"]>>;
    },
  }, store);
  assert(malformedFailure.status === "RECONCILIATION_REQUIRED", "malformed failure fields must not be normalized into trusted evidence");

  const nullProvider = await reconcileProviderDispatch(target, null as never, store);
  assert(nullProvider.status === "RECONCILIATION_REQUIRED", "null provider must fail closed");

  console.log("Provider dispatch reconciliation contract tests: PASS");
}
void main();
