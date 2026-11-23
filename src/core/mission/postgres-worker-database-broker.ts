import type { PgQueryable } from "../persistence/adapters/postgres-tenant-adapter";
import type {
  WorkerDatabaseBroker,
  WorkerDispatchOutbox,
  WorkerReconciliationEvidence,
  WorkerTaskLease,
} from "./worker-database-broker";

export interface WorkerDatabaseSessionProvider {
  /** Must establish the dedicated worker LOGIN session and a bounded transaction. */
  withTransaction<T>(operation: (client: PgQueryable) => Promise<T>): Promise<T>;
}

export class PostgresWorkerDatabaseBrokerError extends Error {
  constructor(readonly code: "WORKER_BROKER_RPC_EMPTY_RESULT" | "WORKER_BROKER_INVALID_DATABASE_ROW") {
    super(code);
    this.name = "PostgresWorkerDatabaseBrokerError";
  }
}

interface WorkerScopeRow {
  workerPrincipalId: string;
  organizationId: string;
  workspaceId: string;
  userId: string;
}

interface LeaseRow {
  lease_id: string;
  attempt: number | string;
  fencing_token: number | string;
  expires_at: string | Date;
  task_version: number | string;
}

interface OutboxRow {
  outbox_id: string;
  organization_id: string;
  workspace_id: string;
  user_id: string;
  mission_id: string;
  task_id: string;
  lease_id: string;
  fencing_token: number | string;
  attempt: number | string;
  execution_request_id: string;
  idempotency_key: string;
  capability: string;
  action: string;
  payload_digest: string;
  payload: Record<string, unknown>;
  outcome: Record<string, unknown>;
  status: WorkerDispatchOutbox["status"];
  created_at: string | Date;
  updated_at: string | Date;
}

interface EvidenceRow {
  evidence_id: string;
  outbox_id: string;
  idempotency_key: string;
  provider_id: string;
  observation_status: WorkerReconciliationEvidence["observationStatus"];
  observed_at: string | Date;
  observation: Record<string, unknown>;
}

function nonEmpty(value: string, field: string): string {
  if (typeof value !== "string" || value.trim().length === 0) {
    throw new TypeError(`Invalid worker broker field: ${field}`);
  }
  return value;
}

function positiveInteger(value: number, field: string): number {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw new TypeError(`Invalid worker broker integer: ${field}`);
  }
  return value;
}

function scopeValues(scope: WorkerScopeRow): string[] {
  return [
    nonEmpty(scope.workerPrincipalId, "workerPrincipalId"),
    nonEmpty(scope.organizationId, "organizationId"),
    nonEmpty(scope.workspaceId, "workspaceId"),
    nonEmpty(scope.userId, "userId"),
  ];
}

function integer(value: number | string, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new PostgresWorkerDatabaseBrokerError("WORKER_BROKER_INVALID_DATABASE_ROW");
  }
  return parsed;
}

function iso(value: string | Date, field: string): string {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new PostgresWorkerDatabaseBrokerError("WORKER_BROKER_INVALID_DATABASE_ROW");
  }
  return parsed.toISOString();
}

function one<Row>(rows: readonly Row[]): Row {
  if (rows.length !== 1) {
    throw new PostgresWorkerDatabaseBrokerError("WORKER_BROKER_RPC_EMPTY_RESULT");
  }
  return rows[0];
}

function mapLease(row: LeaseRow): WorkerTaskLease {
  return Object.freeze({
    leaseId: nonEmpty(row.lease_id, "lease_id"),
    attempt: integer(row.attempt, "attempt"),
    fencingToken: integer(row.fencing_token, "fencing_token"),
    expiresAt: iso(row.expires_at, "expires_at"),
    taskVersion: integer(row.task_version, "task_version"),
  });
}

function mapOutbox(row: OutboxRow): WorkerDispatchOutbox {
  if (!row.payload || typeof row.payload !== "object" || Array.isArray(row.payload) ||
      !row.outcome || typeof row.outcome !== "object" || Array.isArray(row.outcome)) {
    throw new PostgresWorkerDatabaseBrokerError("WORKER_BROKER_INVALID_DATABASE_ROW");
  }
  return Object.freeze({
    outboxId: nonEmpty(row.outbox_id, "outbox_id"),
    organizationId: nonEmpty(row.organization_id, "organization_id"),
    workspaceId: nonEmpty(row.workspace_id, "workspace_id"),
    userId: nonEmpty(row.user_id, "user_id"),
    missionId: nonEmpty(row.mission_id, "mission_id"),
    taskId: nonEmpty(row.task_id, "task_id"),
    leaseId: nonEmpty(row.lease_id, "lease_id"),
    fencingToken: integer(row.fencing_token, "fencing_token"),
    attempt: integer(row.attempt, "attempt"),
    executionRequestId: nonEmpty(row.execution_request_id, "execution_request_id"),
    idempotencyKey: nonEmpty(row.idempotency_key, "idempotency_key"),
    capability: nonEmpty(row.capability, "capability"),
    action: nonEmpty(row.action, "action"),
    payloadDigest: nonEmpty(row.payload_digest, "payload_digest"),
    payload: Object.freeze({ ...row.payload }),
    outcome: Object.freeze({ ...row.outcome }),
    status: row.status,
    createdAt: iso(row.created_at, "created_at"),
    updatedAt: iso(row.updated_at, "updated_at"),
  });
}

function mapEvidence(row: EvidenceRow): WorkerReconciliationEvidence {
  if (!row.observation || typeof row.observation !== "object" || Array.isArray(row.observation)) {
    throw new PostgresWorkerDatabaseBrokerError("WORKER_BROKER_INVALID_DATABASE_ROW");
  }
  return Object.freeze({
    evidenceId: nonEmpty(row.evidence_id, "evidence_id"),
    outboxId: nonEmpty(row.outbox_id, "outbox_id"),
    idempotencyKey: nonEmpty(row.idempotency_key, "idempotency_key"),
    providerId: nonEmpty(row.provider_id, "provider_id"),
    observationStatus: row.observation_status,
    observedAt: iso(row.observed_at, "observed_at"),
    observation: Object.freeze({ ...row.observation }),
  });
}

/**
 * Fixed SQL adapter for the worker-only candidate RPCs. It has no generic SQL
 * surface and always executes inside PostgresWorkerDatabaseSessionProvider.
 * The corresponding candidate SQL must be installed and granted by an
 * explicitly approved operator before this adapter can work against a DB.
 */
export class PostgresWorkerDatabaseBroker implements WorkerDatabaseBroker {
  constructor(private readonly sessions: WorkerDatabaseSessionProvider) {}

  async claimTask(input: Parameters<WorkerDatabaseBroker["claimTask"]>[0]): Promise<WorkerTaskLease> {
    const scope = scopeValues(input.tenantScope);
    nonEmpty(input.missionId, "missionId");
    nonEmpty(input.taskId, "taskId");
    nonEmpty(input.ownerId, "ownerId");
    positiveInteger(input.leaseMilliseconds, "leaseMilliseconds");
    return this.sessions.withTransaction(async (client) => {
      const result = await client.query<LeaseRow>(
        "select * from private.happy_worker_claim_mission_task($1,$2,$3,$4,$5,$6,$7,$8)",
        [...scope, input.missionId, input.taskId, input.ownerId, input.leaseMilliseconds],
      );
      return mapLease(one(result.rows));
    });
  }

  async heartbeatLease(input: Parameters<WorkerDatabaseBroker["heartbeatLease"]>[0]): Promise<string> {
    const scope = scopeValues(input.tenantScope);
    nonEmpty(input.missionId, "missionId");
    nonEmpty(input.taskId, "taskId");
    nonEmpty(input.leaseId, "leaseId");
    nonEmpty(input.ownerId, "ownerId");
    positiveInteger(input.fencingToken, "fencingToken");
    positiveInteger(input.leaseMilliseconds, "leaseMilliseconds");
    return this.sessions.withTransaction(async (client) => {
      const result = await client.query<{ expires_at: string | Date }>(
        "select private.happy_worker_heartbeat_mission_task_lease($1,$2,$3,$4,$5,$6,$7,$8,$9,$10) as expires_at",
        [...scope, input.missionId, input.taskId, input.leaseId, input.ownerId, input.fencingToken, input.leaseMilliseconds],
      );
      return iso(one(result.rows).expires_at, "expires_at");
    });
  }

  async enqueueDispatch(input: Parameters<WorkerDatabaseBroker["enqueueDispatch"]>[0]): Promise<WorkerDispatchOutbox> {
    const scope = scopeValues(input.tenantScope);
    for (const [field, value] of Object.entries({
      missionId: input.missionId, taskId: input.taskId, leaseId: input.leaseId,
      ownerId: input.ownerId, executionRequestId: input.executionRequestId,
      idempotencyKey: input.idempotencyKey, capability: input.capability,
      action: input.action, payloadDigest: input.payloadDigest,
    })) nonEmpty(value, field);
    positiveInteger(input.fencingToken, "fencingToken");
    if (!input.payload || typeof input.payload !== "object" || Array.isArray(input.payload)) {
      throw new TypeError("Invalid worker broker payload");
    }
    return this.sessions.withTransaction(async (client) => {
      const result = await client.query<OutboxRow>(
        "select * from private.happy_worker_enqueue_mission_dispatch($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15)",
        [...scope, input.missionId, input.taskId, input.leaseId, input.ownerId,
          input.fencingToken, input.executionRequestId, input.idempotencyKey,
          input.capability, input.action, input.payloadDigest, input.payload],
      );
      return mapOutbox(one(result.rows));
    });
  }

  async claimNextDispatch(input: Parameters<WorkerDatabaseBroker["claimNextDispatch"]>[0]): Promise<WorkerDispatchOutbox> {
    const scope = scopeValues(input.tenantScope);
    return this.sessions.withTransaction(async (client) => {
      const result = await client.query<OutboxRow>(
        "select * from private.happy_worker_claim_next_dispatch_outbox($1,$2,$3,$4)",
        scope,
      );
      return mapOutbox(one(result.rows));
    });
  }

  async claimDispatch(input: Parameters<WorkerDatabaseBroker["claimDispatch"]>[0]): Promise<WorkerDispatchOutbox> {
    const scope = scopeValues(input.tenantScope);
    for (const [field, value] of Object.entries({
      outboxId: input.outboxId, leaseId: input.leaseId, ownerId: input.ownerId,
    })) nonEmpty(value, field);
    positiveInteger(input.fencingToken, "fencingToken");
    return this.sessions.withTransaction(async (client) => {
      const result = await client.query<OutboxRow>(
        "select * from private.happy_worker_claim_dispatch_outbox($1,$2,$3,$4,$5,$6,$7,$8)",
        [...scope, input.outboxId, input.leaseId, input.ownerId, input.fencingToken],
      );
      return mapOutbox(one(result.rows));
    });
  }

  async recordDispatchOutcome(input: Parameters<WorkerDatabaseBroker["recordDispatchOutcome"]>[0]): Promise<WorkerDispatchOutbox> {
    const scope = scopeValues(input.tenantScope);
    for (const [field, value] of Object.entries({
      outboxId: input.outboxId, leaseId: input.leaseId, ownerId: input.ownerId,
    })) nonEmpty(value, field);
    positiveInteger(input.fencingToken, "fencingToken");
    if (!input.outcome || typeof input.outcome !== "object" || Array.isArray(input.outcome)) {
      throw new TypeError("Invalid worker broker outcome");
    }
    return this.sessions.withTransaction(async (client) => {
      const result = await client.query<OutboxRow>(
        "select * from private.happy_worker_record_dispatch_outcome($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)",
        [...scope, input.outboxId, input.leaseId, input.ownerId, input.fencingToken, input.status, input.outcome],
      );
      return mapOutbox(one(result.rows));
    });
  }

  async appendReconciliationEvidence(input: Parameters<WorkerDatabaseBroker["appendReconciliationEvidence"]>[0]): Promise<string> {
    const scope = scopeValues(input.tenantScope);
    for (const [field, value] of Object.entries({
      outboxId: input.outboxId, evidenceId: input.evidenceId,
      idempotencyKey: input.idempotencyKey, providerId: input.providerId,
      observedAt: input.observedAt,
    })) nonEmpty(value, field);
    if (!input.observation || typeof input.observation !== "object" || Array.isArray(input.observation)) {
      throw new TypeError("Invalid worker reconciliation observation");
    }
    return this.sessions.withTransaction(async (client) => {
      const result = await client.query<{ evidence_id: string }>(
        "select private.happy_worker_append_dispatch_reconciliation_evidence($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) as evidence_id",
        [...scope, input.outboxId, input.evidenceId, input.idempotencyKey,
          input.providerId, input.status, input.observedAt, input.observation],
      );
      return nonEmpty(one(result.rows).evidence_id, "evidence_id");
    });
  }

  async listReconciliationEvidence(input: Parameters<WorkerDatabaseBroker["listReconciliationEvidence"]>[0]): Promise<readonly WorkerReconciliationEvidence[]> {
    const scope = scopeValues(input.tenantScope);
    for (const [field, value] of Object.entries({
      outboxId: input.outboxId, missionId: input.missionId,
      taskId: input.taskId, executionRequestId: input.executionRequestId,
    })) nonEmpty(value, field);
    return this.sessions.withTransaction(async (client) => {
      const result = await client.query<EvidenceRow>(
        "select * from private.happy_worker_list_dispatch_reconciliation_evidence($1,$2,$3,$4,$5,$6,$7,$8)",
        [...scope, input.outboxId, input.missionId, input.taskId, input.executionRequestId],
      );
      return Object.freeze(result.rows.map(mapEvidence));
    });
  }
}
