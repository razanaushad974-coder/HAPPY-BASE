import type { AsyncTenantPersistenceAdapter, TenantPersistedRecord, TenantRecordQuery } from "../../../core/persistence/async-tenant-repository";
import type { EntityType } from "../../../core/persistence/types";
import type { TenantScope } from "../../../core/state/types";
import type { Mission } from "../../../core/mission/types";
import { assessPersistedMissionRecovery } from "../../../core/mission/persisted-recovery-assessment";

const scope: TenantScope & { userId: string } = {
  organizationId: "org-1", workspaceId: "workspace-1", userId: "user-1",
};
const mission: Mission = {
  id: "mission-1", goal: "recover safely", planId: "plan-1", status: "RUNNING",
  taskIds: ["task-1"], rootTaskIds: ["task-1"], completedTaskIds: [],
  failedTaskIds: [], blockedTaskIds: [], progressPercent: 0,
  createdAt: "2026-11-22T00:00:00.000Z", updatedAt: "2026-11-22T00:00:00.000Z",
};
const task = {
  id: "task-1", missionId: "mission-1", action: "BUILD" as const, title: "Build",
  description: "Build safely", status: "RUNNING" as const, dependencyIds: [],
  dependentTaskIds: [], order: 1, retryCount: 0, maxRetries: 3,
  requiresApproval: false, verificationRequired: true,
  createdAt: mission.createdAt, updatedAt: mission.updatedAt,
};
const records = new Map<string, TenantPersistedRecord<unknown>>([
  ["MISSION:mission-1", { id: mission.id, entityType: "MISSION", version: 1, createdAt: mission.createdAt, updatedAt: mission.updatedAt, organizationId: scope.organizationId, workspaceId: scope.workspaceId, userId: scope.userId, data: mission }],
  ["TASK:task-1", { id: task.id, entityType: "TASK", version: 1, createdAt: mission.createdAt, updatedAt: mission.updatedAt, organizationId: scope.organizationId, workspaceId: scope.workspaceId, userId: scope.userId, data: task }],
  ["EXECUTION:execution-1", { id: "execution-1", entityType: "EXECUTION", version: 1, createdAt: mission.createdAt, updatedAt: mission.updatedAt, organizationId: scope.organizationId, workspaceId: scope.workspaceId, userId: scope.userId, data: { id: "result-1", missionId: "mission-1", taskId: "task-1", requestId: "execution-1", outboxId: "outbox-1", status: "RUNNING" } }],
]);
const calls: string[] = [];
const persistence: AsyncTenantPersistenceAdapter = {
  async get<T>(givenScope: TenantScope & { userId: string }, entityType: EntityType, id: string) {
    calls.push(`get:${entityType}:${id}`);
    if (givenScope.organizationId !== scope.organizationId || givenScope.workspaceId !== scope.workspaceId || givenScope.userId !== scope.userId) throw new Error("cross tenant");
    return records.get(`${entityType}:${id}`) as TenantPersistedRecord<T> | undefined;
  },
  async list<T>(givenScope: TenantScope & { userId: string }, query?: TenantRecordQuery) {
    calls.push(`list:${query?.entityType}`);
    if (givenScope.organizationId !== scope.organizationId || givenScope.workspaceId !== scope.workspaceId || givenScope.userId !== scope.userId) throw new Error("cross tenant");
    return [...records.values()].filter((r) => r.entityType === query?.entityType) as TenantPersistedRecord<T>[];
  },
  async create() { throw new Error("read only"); },
  async update() { throw new Error("read only"); },
  async delete() { throw new Error("read only"); },
  async transaction() { throw new Error("read only"); },
};
async function main(): Promise<void> {
const evidenceCalls: unknown[] = [];
const before = JSON.stringify([...records.entries()]);
const result = await assessPersistedMissionRecovery(scope, "mission-1", persistence, {
  async listForExecution(binding) { evidenceCalls.push(binding); return []; },
});
if (result.assessments.length !== 1 ||
    result.assessments[0].disposition !== "EXECUTION_OUTCOME_UNKNOWN" ||
    result.assessments[0].reason !== "EXECUTION_STILL_RUNNING") {
  throw new Error("Persisted RUNNING execution must remain outcome-unknown.");
}
if (evidenceCalls.length !== 1 ||
    JSON.stringify(evidenceCalls[0]) !== JSON.stringify({
      outboxId: "outbox-1", missionId: "mission-1", taskId: "task-1", executionRequestId: "execution-1",
    })) {
  throw new Error("Recovery evidence must be read using exact persisted execution bindings.");
}
if (calls.join("|") !== "get:MISSION:mission-1|get:TASK:task-1|list:EXECUTION") {
  throw new Error("Recovery must use scoped mission/task/execution reads only.");
}
if (before !== JSON.stringify([...records.entries()])) throw new Error("Recovery mutated persisted state.");

// This is the actual orchestration crash window: task is RUNNING and the
// persisted execution request exists, but the result update has not happened.
const initialRequestRecords = new Map(records);
initialRequestRecords.set("EXECUTION:execution-1", {
  ...records.get("EXECUTION:execution-1")!,
  data: {
    id: "execution-1", missionId: "mission-1", taskId: "task-1",
    capability: "CODE", action: "BUILD", input: {}, requiresApproval: false,
    approved: false, risk: "LOW", createdAt: mission.createdAt,
  },
});
const initialRequestPersistence: AsyncTenantPersistenceAdapter = {
  ...persistence,
  async list<T>(givenScope: TenantScope & { userId: string }, query?: TenantRecordQuery) {
    if (givenScope.organizationId !== scope.organizationId || givenScope.workspaceId !== scope.workspaceId || givenScope.userId !== scope.userId) throw new Error("cross tenant");
    return [...initialRequestRecords.values()].filter((r) => r.entityType === query?.entityType) as TenantPersistedRecord<T>[];
  },
};
const initialRequestResult = await assessPersistedMissionRecovery(scope, "mission-1", initialRequestPersistence, {
  async listForExecution() { throw new Error("No outbox exists in the current orchestration producer."); },
});
if (initialRequestResult.assessments[0]?.disposition !== "RECONCILIATION_REQUIRED" ||
    initialRequestResult.assessments[0]?.reason !== "EXECUTION_STATE_UNCONFIRMED") {
  throw new Error("Pre-result execution request must require reconciliation, never be treated as a confirmed RUNNING outcome.");
}
if (Object.keys(initialRequestResult.evidenceByTask).length !== 0) {
  throw new Error("Recovery must not synthesize an outbox evidence lookup for the current producer.");
}

const wrongTenant: AsyncTenantPersistenceAdapter = {
  ...persistence,
  async get<T>() {
    return { ...records.get("MISSION:mission-1")!, organizationId: "other-org" } as TenantPersistedRecord<T>;
  },
};
let scopeMismatchDenied = false;
try { await assessPersistedMissionRecovery(scope, "mission-1", wrongTenant); }
catch (error) { scopeMismatchDenied = error instanceof Error && error.message === "MISSION_RECOVERY_TENANT_SCOPE_MISMATCH"; }
if (!scopeMismatchDenied) throw new Error("Cross-tenant mission record must be rejected.");

const malformedExecution: AsyncTenantPersistenceAdapter = {
  ...persistence,
  async list<T>() {
    return [{ ...records.get("EXECUTION:execution-1")!, data: { taskId: "task-1", status: "RUNNING" } }] as TenantPersistedRecord<T>[];
  },
};
let malformedDenied = false;
try { await assessPersistedMissionRecovery(scope, "mission-1", malformedExecution); }
catch (error) { malformedDenied = error instanceof Error && error.message === "MISSION_RECOVERY_EXECUTION_RECORD_MALFORMED"; }
if (!malformedDenied) throw new Error("Malformed execution record must fail closed.");

const mismatchedRequest: AsyncTenantPersistenceAdapter = {
  ...persistence,
  async list<T>() {
    return [{ ...records.get("EXECUTION:execution-1")!, data: { id: "result-1", missionId: "mission-1", taskId: "task-1", requestId: "different-request", status: "COMPLETED" } }] as TenantPersistedRecord<T>[];
  },
};
let requestMismatchDenied = false;
try { await assessPersistedMissionRecovery(scope, "mission-1", mismatchedRequest); }
catch (error) { requestMismatchDenied = error instanceof Error && error.message === "MISSION_RECOVERY_EXECUTION_BINDING_INVALID"; }
if (!requestMismatchDenied) throw new Error("Execution result with a substituted request ID must be rejected.");

console.log("Persisted mission recovery assessment: PASS");

}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
