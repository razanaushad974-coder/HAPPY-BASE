import type { ExecutionStatus } from "../execution/types";
import type { AsyncTenantPersistenceAdapter, TenantPersistedRecord } from "../persistence/async-tenant-repository";
import type { TenantScope } from "../state/types";
import type { Mission, MissionTask } from "./types";
import { assessMissionRecovery, type MissionRecoveryExecution, type MissionTaskRecoveryAssessment } from "./recovery-assessment";
import type { PersistedProviderReconciliationEvidence } from "../persistence/postgres-provider-reconciliation-evidence-store";
import type { WorkerDatabaseBroker, WorkerTenantScope } from "./worker-database-broker";

export interface RecoveryEvidenceReader {
  listForExecution(binding: {
    outboxId: string;
    missionId: string;
    taskId: string;
    executionRequestId: string;
  }): Promise<PersistedProviderReconciliationEvidence[]>;
}

/**
 * Adapts the authenticated durable worker broker to the mission recovery
 * reader. The broker RPC performs the authoritative tenant/outbox/mission/
 * task/request binding in PostgreSQL; this adapter additionally rejects any
 * response that escapes the requested outbox binding.
 */
export function createWorkerBrokerRecoveryEvidenceReader(
  broker: Pick<WorkerDatabaseBroker, "listReconciliationEvidence">,
  tenantScope: WorkerTenantScope,
  scope: TenantScope & { userId: string },
): RecoveryEvidenceReader {
  if (!broker || typeof broker.listReconciliationEvidence !== "function" ||
      !tenantScope || typeof tenantScope.workerPrincipalId !== "string" ||
      !tenantScope.workerPrincipalId.trim() ||
      tenantScope.organizationId !== scope.organizationId ||
      tenantScope.workspaceId !== scope.workspaceId ||
      tenantScope.userId !== scope.userId) {
    throw new Error("MISSION_RECOVERY_WORKER_SCOPE_INVALID");
  }
  return Object.freeze({
    async listForExecution(binding) {
      if (!binding || typeof binding !== "object" ||
          typeof binding.outboxId !== "string" || !binding.outboxId.trim() ||
          typeof binding.missionId !== "string" || !binding.missionId.trim() ||
          typeof binding.taskId !== "string" || !binding.taskId.trim() ||
          typeof binding.executionRequestId !== "string" || !binding.executionRequestId.trim()) {
        throw new Error("MISSION_RECOVERY_EVIDENCE_BINDING_INVALID");
      }
      const rows = await broker.listReconciliationEvidence({
        tenantScope,
        outboxId: binding.outboxId,
        missionId: binding.missionId,
        taskId: binding.taskId,
        executionRequestId: binding.executionRequestId,
      });
      if (!Array.isArray(rows) || rows.some((row) =>
        !row || typeof row !== "object" ||
        row.outboxId !== binding.outboxId ||
        typeof row.evidenceId !== "string" || !row.evidenceId.trim() ||
        typeof row.idempotencyKey !== "string" || !row.idempotencyKey.trim() ||
        typeof row.providerId !== "string" || !row.providerId.trim() ||
        typeof row.observedAt !== "string" || !Number.isFinite(Date.parse(row.observedAt)) ||
        !["SUCCEEDED", "FAILED", "PROCESSING", "NOT_FOUND", "UNKNOWN"].includes(row.observationStatus) ||
        !row.observation || typeof row.observation !== "object" || Array.isArray(row.observation)
      )) {
        throw new Error("MISSION_RECOVERY_EVIDENCE_BINDING_INVALID");
      }
      return rows.map((row) => ({
        evidenceId: row.evidenceId,
        outboxId: row.outboxId,
        idempotencyKey: row.idempotencyKey,
        providerId: row.providerId,
        observationStatus: row.observationStatus,
        observedAt: row.observedAt,
        observation: Object.fromEntries(
          Object.entries(row.observation).filter((entry): entry is [string, string] =>
            typeof entry[1] === "string"
          ),
        ),
      }));
    },
  });
}

interface PersistedExecutionSnapshot {
  id: string;
  missionId: string;
  taskId: string;
  status?: ExecutionStatus;
  requestId?: string;
  outboxId?: string;
}

export interface PersistedMissionRecoveryResult {
  missionId: string;
  assessments: MissionTaskRecoveryAssessment[];
  evidenceByTask: Record<string, PersistedProviderReconciliationEvidence[]>;
}

/**
 * Read-only recovery composition over authenticated tenant persistence.
 * It accepts both actual orchestration snapshots: the pre-execution request
 * (data.id equals the persisted record ID, with no result status yet) and the
 * post-execution result (data.requestId equals the persisted record ID).
 * It never changes state, retries, or dispatches work.
 */
export async function assessPersistedMissionRecovery(
  scope: TenantScope & { userId: string },
  missionId: string,
  persistence: AsyncTenantPersistenceAdapter,
  evidenceReader?: RecoveryEvidenceReader,
): Promise<PersistedMissionRecoveryResult> {
  if (!scope || typeof scope !== "object" ||
      typeof scope.organizationId !== "string" || !scope.organizationId.trim() ||
      typeof scope.workspaceId !== "string" || !scope.workspaceId.trim() ||
      typeof scope.userId !== "string" || !scope.userId.trim() ||
      typeof missionId !== "string" || !missionId.trim() ||
      !persistence || typeof persistence.get !== "function" || typeof persistence.list !== "function") {
    throw new Error("MISSION_RECOVERY_SCOPE_OR_REPOSITORY_INVALID");
  }

  const missionRecord = await persistence.get<Mission>(scope, "MISSION", missionId);
  if (!missionRecord) throw new Error("MISSION_RECOVERY_MISSION_NOT_FOUND");
  assertTenantRecordScope(missionRecord, scope);
  if (missionRecord.id !== missionId || missionRecord.entityType !== "MISSION" ||
      !missionRecord.data || typeof missionRecord.data !== "object" ||
      missionRecord.data.id !== missionId || !Array.isArray(missionRecord.data.taskIds) ||
      missionRecord.data.taskIds.length > 500 ||
      missionRecord.data.taskIds.some((id) => typeof id !== "string" || !id.trim()) ||
      new Set(missionRecord.data.taskIds).size !== missionRecord.data.taskIds.length) {
    throw new Error("MISSION_RECOVERY_MISSION_BINDING_INVALID");
  }
  const mission = missionRecord.data;

  const taskRecords = await Promise.all(mission.taskIds.map(async (taskId) => {
    const record = await persistence.get<MissionTask>(scope, "TASK", taskId);
    if (!record) throw new Error("MISSION_RECOVERY_TASK_NOT_FOUND");
    assertTenantRecordScope(record, scope);
    if (record.id !== taskId || record.entityType !== "TASK" ||
        !record.data || record.data.id !== taskId || record.data.missionId !== missionId) {
      throw new Error("MISSION_RECOVERY_TASK_BINDING_INVALID");
    }
    return record;
  }));
  const tasks = taskRecords.map((record) => record.data);

  const executionRecords = await persistence.list<PersistedExecutionSnapshot>(scope, {
    entityType: "EXECUTION",
    limit: 500,
  });
  if (executionRecords.length >= 500) {
    throw new Error("MISSION_RECOVERY_EXECUTION_SNAPSHOT_INCOMPLETE");
  }

  const executions: MissionRecoveryExecution[] = [];
  const executionBindings: Array<{ executionId: string; taskId: string; requestId: string; outboxId?: string }> = [];
  for (const record of executionRecords) {
    assertTenantRecordScope(record, scope);
    if (!record.data || typeof record.data !== "object" ||
        typeof record.data.missionId !== "string" ||
        typeof record.data.taskId !== "string" ||
        (record.data.status !== undefined && typeof record.data.status !== "string")) {
      throw new Error("MISSION_RECOVERY_EXECUTION_RECORD_MALFORMED");
    }
    if (record.data.missionId !== missionId) continue;

    const hasResultRequestId = typeof record.data.requestId === "string" && !!record.data.requestId.trim();
    const isInitialRequest = record.data.requestId === undefined && record.data.id === record.id;
    if (record.entityType !== "EXECUTION" || typeof record.id !== "string" || !record.id.trim() ||
        (!hasResultRequestId && !isInitialRequest) ||
        (hasResultRequestId && record.data.requestId !== record.id) ||
        (typeof record.data.id !== "string" || !record.data.id.trim()) ||
        (record.data.outboxId !== undefined &&
          (typeof record.data.outboxId !== "string" || !record.data.outboxId.trim()))) {
      throw new Error("MISSION_RECOVERY_EXECUTION_BINDING_INVALID");
    }

    const requestId = hasResultRequestId ? record.data.requestId! : record.id;
    executions.push({
      id: record.id,
      missionId: record.data.missionId,
      taskId: record.data.taskId,
      status: record.data.status,
    });
    executionBindings.push({
      executionId: record.id,
      taskId: record.data.taskId,
      requestId,
      outboxId: record.data.outboxId,
    });
  }

  const assessments = assessMissionRecovery(mission, tasks, executions);
  const evidenceByTask: Record<string, PersistedProviderReconciliationEvidence[]> = {};
  for (const assessment of assessments) {
    if (assessment.disposition !== "RECONCILIATION_REQUIRED" &&
        assessment.disposition !== "EXECUTION_OUTCOME_UNKNOWN") continue;
    const binding = executionBindings.find((item) =>
      item.taskId === assessment.taskId && item.executionId === assessment.executionId
    );
    // The current synchronous orchestration producer does not create a
    // durable outbox ID. Evidence lookup is only allowed when one is truly
    // present on the persisted record; never synthesize an outbox binding.
    if (!binding?.outboxId) continue;
    // An outbox-bound ambiguous execution must not silently look like it has
    // no reconciliation evidence merely because the caller omitted its reader.
    if (!evidenceReader) throw new Error("MISSION_RECOVERY_EVIDENCE_READER_REQUIRED");
    const evidence = await evidenceReader.listForExecution({
      outboxId: binding.outboxId,
      missionId,
      taskId: assessment.taskId,
      executionRequestId: binding.requestId,
    });
    if (!Array.isArray(evidence) || evidence.some((item) =>
      !item || typeof item !== "object" ||
      item.outboxId !== binding.outboxId ||
      typeof item.evidenceId !== "string" || !item.evidenceId.trim() ||
      typeof item.idempotencyKey !== "string" || !item.idempotencyKey.trim() ||
      typeof item.providerId !== "string" || !item.providerId.trim() ||
      !Number.isFinite(Date.parse(item.observedAt)) ||
      !["SUCCEEDED", "FAILED", "PROCESSING", "NOT_FOUND", "UNKNOWN"].includes(item.observationStatus)
    )) {
      throw new Error("MISSION_RECOVERY_EVIDENCE_BINDING_INVALID");
    }
    evidenceByTask[assessment.taskId] = evidence;
  }

  return { missionId, assessments, evidenceByTask };
}

function assertTenantRecordScope(
  record: TenantPersistedRecord<unknown>,
  scope: TenantScope & { userId: string },
): void {
  if (record.organizationId !== scope.organizationId ||
      record.workspaceId !== scope.workspaceId ||
      record.userId !== scope.userId) {
    throw new Error("MISSION_RECOVERY_TENANT_SCOPE_MISMATCH");
  }
}
