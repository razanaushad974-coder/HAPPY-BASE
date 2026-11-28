import {
  PostgresProviderReconciliationEvidenceStore,
} from "../../../core/persistence/postgres-provider-reconciliation-evidence-store";
import type {
  PostgresTenantSessionProvider,
  PgQueryable,
} from "../../../core/persistence/adapters/postgres-tenant-adapter";
import type { TenantScope } from "../../../core/state/types";

type CompleteScope = TenantScope & { userId: string };
type SessionOperation<T> = (client: PgQueryable) => Promise<T>;

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
const scope = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "20000000-0000-4000-8000-000000000002",
  userId: "30000000-0000-4000-8000-000000000003",
};
const outboxId = "40000000-0000-4000-8000-000000000004";
const evidenceId = "50000000-0000-4000-8000-000000000005";

async function main(): Promise<void> {
  const calls: Array<{ scope: unknown; sql: string; values: readonly unknown[] }> = [];
  const sessions: PostgresTenantSessionProvider = {
    async withSession<T>(boundScope: CompleteScope, operation: SessionOperation<T>) {
      const client: PgQueryable = {
        async query<Row>(sql: string, values: readonly unknown[] = []) {
          calls.push({ scope: boundScope, sql, values });
          return { rows: [{ evidence_id: evidenceId }] as Row[], rowCount: 1 };
        },
      };
      return operation(client);
    },
    async withTransaction<T>(boundScope: CompleteScope, operation: SessionOperation<T>) {
      return this.withSession(boundScope, operation);
    },
  };
  const store = new PostgresProviderReconciliationEvidenceStore(sessions, scope, () => evidenceId);
  await store.append({
    outboxId,
    idempotencyKey: "stable-key-1",
    providerId: "provider-a",
    observedAt: "2026-11-21T10:00:00.000Z",
    observation: {
      status: "SUCCEEDED",
      providerRequestId: "remote-123",
      result: { accessToken: "must-not-persist", nested: { secret: "also-excluded" } },
    },
  });
  assert(calls.length === 1, "one append RPC call expected");
  assert(calls[0].scope === scope, "exact authenticated tenant scope must be used");
  assert(calls[0].sql.includes("happy_append_dispatch_reconciliation_evidence"), "append RPC must be used");
  assert(calls[0].values[0] === scope.organizationId && calls[0].values[1] === scope.workspaceId, "tenant IDs must be bound");
  assert(calls[0].values[2] === outboxId && calls[0].values[3] === evidenceId, "outbox/evidence IDs must be bound");
  const payload = JSON.parse(String(calls[0].values[8])) as Record<string, unknown>;
  assert(payload.status === "SUCCEEDED" && payload.providerRequestId === "remote-123", "allow-listed success identity must persist");
  assert(!("result" in payload) && !JSON.stringify(payload).includes("must-not-persist"), "provider result body must not be persisted");

  const readCalls: Array<{ sql: string; values: readonly unknown[] }> = [];
  const readSessions: PostgresTenantSessionProvider = {
    ...sessions,
    async withSession<T>(_boundScope: CompleteScope, operation: SessionOperation<T>) {
      const client: PgQueryable = {
        async query<Row>(sql: string, values: readonly unknown[] = []) {
          readCalls.push({ sql, values });
          return { rows: [{
            evidence_id: evidenceId, outbox_id: outboxId, idempotency_key: "stable-key-1",
            provider_id: "provider-a", observation_status: "SUCCEEDED",
            observed_at: "2026-11-21T10:00:00.000Z",
            observation: { status: "SUCCEEDED", providerRequestId: "remote-123" },
          }] as Row[], rowCount: 1 };
        },
      };
      return operation(client);
    },
  };
  const readStore = new PostgresProviderReconciliationEvidenceStore(readSessions, scope, () => evidenceId);
  const persisted = await readStore.listForExecution({
    outboxId, missionId: "mission-1", taskId: "task-1", executionRequestId: "execution-1",
  });
  assert(persisted.length === 1 && persisted[0].observationStatus === "SUCCEEDED", "bound persisted evidence must be returned");
  assert(readCalls[0].sql.includes("happy_list_dispatch_reconciliation_evidence"), "evidence reads must use the scoped RPC");
  assert(readCalls[0].values.join("|") === [scope.organizationId, scope.workspaceId, outboxId, "mission-1", "task-1", "execution-1"].join("|"), "read must bind exact tenant/mission/task/execution identity");
  let invalidReadDenied = false;
  try { await readStore.listForExecution({ outboxId: "not-a-uuid", missionId: "mission-1", taskId: "task-1", executionRequestId: "execution-1" }); }
  catch (error) { invalidReadDenied = error instanceof Error && error.message === "RECONCILIATION_READ_BINDING_INVALID"; }
  assert(invalidReadDenied && readCalls.length === 1, "invalid evidence read binding must fail before database access");

  let invalidScopeCalls = 0;
  const invalidScopeStore = new PostgresProviderReconciliationEvidenceStore({
    ...sessions,
    async withSession<T>(_boundScope: CompleteScope, _operation: SessionOperation<T>): Promise<T> { invalidScopeCalls++; throw new Error("must not reach database"); },
  }, { ...scope, userId: "not-a-uuid" }, () => evidenceId);
  let invalidScopeRejected = false;
  try {
    await invalidScopeStore.append({
      outboxId, idempotencyKey: "key", providerId: "provider-a",
      observedAt: "2026-11-21T10:00:00.000Z", observation: { status: "NOT_FOUND" },
    });
  } catch (error) {
    invalidScopeRejected = error instanceof Error && error.message === "RECONCILIATION_TENANT_SCOPE_INVALID";
  }
  assert(invalidScopeRejected && invalidScopeCalls === 0, "invalid scope must fail before database access");

  let invalidTimestampRejected = false;
  try {
    await store.append({
      outboxId, idempotencyKey: "key", providerId: "provider-a",
      observedAt: "not-a-date", observation: { status: "NOT_FOUND" },
    });
  } catch (error) {
    invalidTimestampRejected = error instanceof Error && error.message === "RECONCILIATION_OBSERVATION_TIMESTAMP_INVALID";
  }
  assert(invalidTimestampRejected && calls.length === 1, "invalid timestamp must fail before database access");

  let mismatchRejected = false;
  const mismatchStore = new PostgresProviderReconciliationEvidenceStore({
    ...sessions,
    async withSession<T>(boundScope: CompleteScope, operation: SessionOperation<T>) {
      const client: PgQueryable = {
        async query<Row>() {
          return { rows: [{ evidence_id: "60000000-0000-4000-8000-000000000006" }] as Row[], rowCount: 1 };
        },
      };
      return operation(client);
    },
  }, scope, () => evidenceId);
  try {
    await mismatchStore.append({
      outboxId, idempotencyKey: "key", providerId: "provider-a",
      observedAt: "2026-11-21T10:00:00.000Z", observation: { status: "NOT_FOUND" },
    });
  } catch (error) {
    mismatchRejected = error instanceof Error && error.message === "RECONCILIATION_EVIDENCE_APPEND_UNCONFIRMED";
  }
  assert(mismatchRejected, "unexpected RPC identity must not be treated as persisted");

  const nullEvidenceRejected = await store.append(null as never).then(() => false, (error) => error instanceof Error && error.message === "RECONCILIATION_EVIDENCE_INVALID");
  assert(nullEvidenceRejected && calls.length === 1, "null evidence must fail before database access");

  const malformedCases: Array<{ evidence: never; expected: string }> = [
    { evidence: { outboxId, idempotencyKey: "key", providerId: "provider-a", observedAt: "2026-11-21T10:00:00.000Z", observation: { status: "ALIEN" } } as never, expected: "RECONCILIATION_OBSERVATION_STATUS_INVALID" },
    { evidence: { outboxId, idempotencyKey: "key", providerId: "provider-a", observedAt: "2026-11-21T10:00:00.000Z", observation: { status: "SUCCEEDED", providerRequestId: 7, result: {} } } as never, expected: "RECONCILIATION_PROVIDER_REQUEST_ID_INVALID" },
    { evidence: { outboxId, idempotencyKey: "key", providerId: "provider-a", observedAt: "2026-11-21T10:00:00.000Z", observation: { status: "FAILED", providerRequestId: "remote", code: 9, message: "bad" } } as never, expected: "RECONCILIATION_FAILURE_DETAILS_INVALID" },
    { evidence: { outboxId, idempotencyKey: "key", providerId: "provider-a", observedAt: "2026-11-21T10:00:00.000Z", observation: { status: "UNKNOWN", reason: null } } as never, expected: "RECONCILIATION_UNKNOWN_REASON_INVALID" },
  ];
  for (const item of malformedCases) {
    let rejected = false;
    try { await store.append(item.evidence); }
    catch (error) { rejected = error instanceof Error && error.message === item.expected; }
    assert(rejected && calls.length === 1, "malformed evidence must fail before database access: " + item.expected);
  }
  console.log("PostgreSQL provider reconciliation evidence store tests: PASS");
}
void main();
