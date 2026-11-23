import type { PgQueryable } from "../../../core/persistence/adapters/postgres-tenant-adapter";
import { PostgresWorkerDatabaseBroker } from "../../../core/mission/postgres-worker-database-broker";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const calls: Array<{ sql: string; values: readonly unknown[] }> = [];
let transactionCount = 0;
let noPendingDispatch = false;

const outboxRow = {
  outbox_id: "outbox-1",
  organization_id: "org-1",
  workspace_id: "workspace-1",
  user_id: "user-1",
  mission_id: "mission-1",
  task_id: "task-1",
  lease_id: "lease-1",
  fencing_token: "4",
  attempt: "2",
  execution_request_id: "request-1",
  idempotency_key: "idem-1",
  capability: "FILE",
  action: "READ",
  payload_digest: "sha256:" + "a".repeat(64),
  payload: { id: "request-1" },
  outcome: {},
  status: "PENDING" as const,
  created_at: "2026-11-22T00:00:00.000Z",
  updated_at: "2026-11-22T00:00:00.000Z",
};

const session = {
  async withTransaction<T>(operation: (client: PgQueryable) => Promise<T>): Promise<T> {
    transactionCount += 1;
    const client: PgQueryable = {
      async query<Row>(sql: string, values: readonly unknown[] = []) {
        calls.push({ sql, values });
        let rows: unknown[];
        if (sql.includes("happy_worker_claim_next_dispatch_outbox(") && noPendingDispatch) {
          rows = [];
        } else if (sql.includes("happy_worker_claim_mission_task(")) {
          rows = [{ lease_id: "lease-1", attempt: "2", fencing_token: "4", expires_at: "2026-11-22T00:05:00.000Z", task_version: "9" }];
        } else if (sql.includes("happy_worker_heartbeat_mission_task_lease(")) {
          rows = [{ expires_at: "2026-11-22T00:06:00.000Z" }];
        } else if (sql.includes("happy_worker_append_dispatch_reconciliation_evidence(")) {
          rows = [{ evidence_id: "evidence-1" }];
        } else if (sql.includes("happy_worker_list_dispatch_reconciliation_evidence(")) {
          rows = [{
            evidence_id: "evidence-1", outbox_id: "outbox-1", idempotency_key: "idem-1",
            provider_id: "provider-1", observation_status: "UNKNOWN",
            observed_at: "2026-11-22T00:07:00.000Z", observation: { status: "UNKNOWN" },
          }];
        } else {
          rows = [outboxRow];
        }
        return { rows: rows as Row[], rowCount: rows.length };
      },
    };
    return operation(client);
  },
};

async function run() {
  const broker = new PostgresWorkerDatabaseBroker(session);
  const tenantScope = {
    workerPrincipalId: "worker-principal-1",
    organizationId: "org-1",
    workspaceId: "workspace-1",
    userId: "user-1",
  };

  const lease = await broker.claimTask({
    tenantScope, missionId: "mission-1", taskId: "task-1",
    ownerId: "worker-instance-1", leaseMilliseconds: 30_000,
  });
  assert(lease.leaseId === "lease-1" && lease.fencingToken === 4 && lease.taskVersion === 9,
    "claimTask must map the fenced lease result");

  const heartbeat = await broker.heartbeatLease({
    tenantScope, missionId: "mission-1", taskId: "task-1",
    leaseId: "lease-1", ownerId: "worker-instance-1",
    fencingToken: 4, leaseMilliseconds: 30_000,
  });
  assert(heartbeat === "2026-11-22T00:06:00.000Z", "heartbeat must return the normalized expiry");

  const dispatch = await broker.enqueueDispatch({
    tenantScope, missionId: "mission-1", taskId: "task-1",
    leaseId: "lease-1", ownerId: "worker-instance-1", fencingToken: 4,
    executionRequestId: "request-1", idempotencyKey: "idem-1",
    capability: "FILE", action: "READ",
    payloadDigest: "sha256:" + "a".repeat(64), payload: { id: "request-1" },
  });
  assert(dispatch.outboxId === "outbox-1" && Object.isFrozen(dispatch.payload),
    "enqueueDispatch must return an immutable typed outbox snapshot");

  const nextDispatch = await broker.claimNextDispatch({ tenantScope, ownerId: "worker-instance-1" });
  assert(nextDispatch.outboxId === "outbox-1",
    "claimNextDispatch must atomically return the next eligible outbox row");

  const claimed = await broker.claimDispatch({
    tenantScope, outboxId: "outbox-1", leaseId: "lease-1",
    ownerId: "worker-instance-1", fencingToken: 4,
  });
  assert(claimed.outboxId === "outbox-1", "claimDispatch must return the claimed outbox");

  const outcome = await broker.recordDispatchOutcome({
    tenantScope, outboxId: "outbox-1", leaseId: "lease-1",
    ownerId: "worker-instance-1", fencingToken: 4,
    status: "AMBIGUOUS", outcome: { provider: "provider-1", status: "UNKNOWN" },
  });
  assert(outcome.outboxId === "outbox-1", "recordDispatchOutcome must return the persisted outbox");

  const evidenceId = await broker.appendReconciliationEvidence({
    tenantScope, outboxId: "outbox-1", evidenceId: "evidence-1",
    idempotencyKey: "idem-1", providerId: "provider-1",
    observedAt: "2026-11-22T00:07:00.000Z", status: "UNKNOWN",
    observation: { status: "UNKNOWN" },
  });
  assert(evidenceId === "evidence-1", "append evidence must return the persisted evidence ID");

  const evidence = await broker.listReconciliationEvidence({
    tenantScope, outboxId: "outbox-1", missionId: "mission-1",
    taskId: "task-1", executionRequestId: "request-1",
  });
  assert(evidence.length === 1 && evidence[0].evidenceId === "evidence-1",
    "list evidence must map the scoped evidence rows");

  noPendingDispatch = true;
  const emptyQueue = await broker.claimNextDispatch({ tenantScope, ownerId: "worker-instance-1" });
  assert(emptyQueue === null, "an empty dispatch queue must return null without fabricating work");

  assert(transactionCount === 9 && calls.length === 9,
    "every fixed broker operation must execute in its own worker transaction");
  for (const call of calls) {
    const placeholders = [...call.sql.matchAll(/\$(\d+)/g)].map((match) => Number(match[1]));
    assert(placeholders.length === call.values.length,
      "SQL placeholder count must match the bound argument count");
    assert(call.sql.startsWith("select ") && call.sql.includes("private.happy_worker_"),
      "adapter must call only fixed private worker RPCs");
  }

  let rejected = false;
  try {
    await broker.claimTask({
      tenantScope: { ...tenantScope, userId: " " },
      missionId: "mission-1", taskId: "task-1",
      ownerId: "worker-instance-1", leaseMilliseconds: 30_000,
    });
  } catch {
    rejected = true;
  }
  assert(rejected && transactionCount === 9,
    "invalid scope selectors must fail before opening a database transaction");

  console.log("PostgreSQL worker database broker contract: PASS");
}

void run();
