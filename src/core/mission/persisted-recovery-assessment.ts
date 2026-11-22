import type { ExecutionStatus } from "../execution/types";
import type { AsyncTenantPersistenceAdapter, TenantPersistedRecord } from "../persistence/async-tenant-repository";
import type { TenantScope } from "../state/types";
import type { Mission, MissionTask } from "./types";
import { assessMissionRecovery, type MissionRecoveryExecution, type MissionTaskRecoveryAssessment } from "./recovery-assessment";
import type { PersistedProviderReconciliationEvidence } from "../persistence/postgres-provider-reconciliation-evidence-store";

export interface RecoveryEvidenceReader {
  listForExecution(binding: {
    outboxId: string;
    missionId: string;
    taskId: string;
    executionRequestId: string;
  }): Promise<PersistedProviderReconciliationEvidence[]>;
}

interface PersistedExecutionSnapshot {
  missionId: string;
  taskId: string;
  status: ExecutionStatus;
  requestId: string;
  outboxId?: string;
}

export interface PersistedMissionRecoveryResult {
  missionId: string;
  assessments: MissionTaskRecoveryAssessment[];
  evidenceByTask: Record<string, PersistedProviderReconciliationEvidence[]>;
}

/**
 * Read-only recovery composition over authenticated tenant persistence.
 * All records are loaded through the same complete tenant scope. It never
 * changes mission/task/execution state and never retries or dispatches work.
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
      !missionRecord.data || missionRecord.data.id !== missionId) {
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
  const executions: MissionRecoveryExecution[] = [];
  const executionBindings: Array<{ executionId: string; taskId: string; requestId: string; outboxId?: string }> = [];
  for (const record of executionRecords) {
    assertTenantRecordScope(record, scope);
    if (!record.data || typeof record.data !== "object" ||
        typeof record.data.missionId !== "string" || typeof record.data.taskId !== "string" ||
        typeof record.data.status !== "string") {
      throw new Error("MISSION_RECOVERY_EXECUTION_RECORD_MALFORMED");
    }
    if (record.data.missionId !== missionId) continue;
    if (record.entityType !== "EXECUTION" || !record.id.trim() ||
        typeof record.data.requestId !== "string" || !record.data.requestId.trim() ||
        (record.data.outboxId !== undefined &&
          (typeof record.data.outboxId !== "string" || !record.data.outboxId.trim()))) {
      throw new Error("MISSION_RECOVERY_EXECUTION_BINDING_INVALID");
    }
    executions.push({
      id: record.id,
      missionId: record.data.missionId,
      taskId: record.data.taskId,
      status: record.data.status,
    });
    executionBindings.push({
      executionId: record.id,
      taskId: record.data.taskId,
      requestId: record.data.requestId,
      outboxId: record.data.outboxId,
    });
  }

  const assessments = assessMissionRecovery(mission, tasks, executions);
  const evidenceByTask: Record<string, PersistedProviderReconciliationEvidence[]> = {};
  if (evidenceReader) {
    for (const assessment of assessments) {
      if (assessment.disposition !== "RECONCILIATION_REQUIRED" &&
          assessment.disposition !== "EXECUTION_OUTCOME_UNKNOWN") continue;
      const binding = executionBindings.find((item) =>
        item.taskId === assessment.taskId && item.executionId === assessment.executionId
      );
      if (!binding?.outboxId) continue;
      evidenceByTask[assessment.taskId] = await evidenceReader.listForExecution({
        outboxId: binding.outboxId,
        missionId,
        taskId: assessment.taskId,
        executionRequestId: binding.requestId,
      });
    }
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
