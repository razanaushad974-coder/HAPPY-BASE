import type { AsyncTenantPersistenceAdapter, TenantPersistedRecord, TenantRecordQuery } from "../../../core/persistence/async-tenant-repository";
import type { EntityType } from "../../../core/persistence/types";
import type { TenantScope } from "../../../core/state/types";
import type { Mission } from "../../../core/mission/types";
import { assessPersistedMissionRecovery } from "../../../core/mission/persisted-recovery-assessment";
import { MissionOrchestrator } from "../../../core/mission/orchestrator";
import { createWorkerBrokerRecoveryEvidenceReader } from "../../../core/mission/persisted-recovery-assessment";

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

const brokerEvidenceCalls: unknown[] = [];
const workerEvidenceReader = createWorkerBrokerRecoveryEvidenceReader({
  async listReconciliationEvidence(input) {
    brokerEvidenceCalls.push(input);
    return [{
      evidenceId: "evidence-1", outboxId: input.outboxId,
      idempotencyKey: "key-1", providerId: "provider-1",
      observationStatus: "SUCCEEDED" as const,
      observedAt: "2026-11-22T00:00:00.000Z",
      observation: { status: "SUCCEEDED", providerRequestId: "remote-1" },
    }];
  },
}, {
  workerPrincipalId: "worker-1",
  organizationId: scope.organizationId,
  workspaceId: scope.workspaceId,
  userId: scope.userId,
}, scope);
const brokerBackedAssessment = await assessPersistedMissionRecovery(
  scope, "mission-1", persistence, workerEvidenceReader,
);
if (brokerEvidenceCalls.length !== 1 ||
    brokerBackedAssessment.evidenceByTask["task-1"]?.[0]?.evidenceId !== "evidence-1") {
  throw new Error("Durable worker broker evidence must be exposed to mission recovery.");
}
const brokerBinding = brokerEvidenceCalls[0] as Record<string, unknown>;
if (brokerBinding.outboxId !== "outbox-1" ||
    brokerBinding.missionId !== "mission-1" ||
    brokerBinding.taskId !== "task-1" ||
    brokerBinding.executionRequestId !== "execution-1") {
  throw new Error("Worker evidence adapter must preserve exact persisted execution binding.");
}
let brokerScopeMismatchDenied = false;
try {
  createWorkerBrokerRecoveryEvidenceReader({
    async listReconciliationEvidence() { return []; },
  }, {
    workerPrincipalId: "worker-1",
    organizationId: "other-org",
    workspaceId: scope.workspaceId,
    userId: scope.userId,
  }, scope);
} catch (error) {
  brokerScopeMismatchDenied = error instanceof Error &&
    error.message === "MISSION_RECOVERY_WORKER_SCOPE_INVALID";
}
if (!brokerScopeMismatchDenied) {
  throw new Error("Worker evidence adapter must reject a mismatched tenant scope.");
}
const mutableWorkerScope = {
  workerPrincipalId: "worker-1",
  organizationId: scope.organizationId,
  workspaceId: scope.workspaceId,
  userId: scope.userId,
};
const capturedWorkerCalls: unknown[] = [];
const immutableReader = createWorkerBrokerRecoveryEvidenceReader({
  async listReconciliationEvidence(input) {
    capturedWorkerCalls.push(input);
    return [];
  },
}, mutableWorkerScope, scope);
mutableWorkerScope.organizationId = "attacker-org";
await immutableReader.listForExecution({
  outboxId: "outbox-1", missionId: "mission-1",
  taskId: "task-1", executionRequestId: "execution-1",
});
const capturedBinding = capturedWorkerCalls[0] as { tenantScope: { organizationId: string } };
if (capturedBinding.tenantScope.organizationId !== scope.organizationId) {
  throw new Error("Recovery evidence reader must snapshot, not retain a mutable worker tenant scope.");
}
// Isolate the orchestrator assertion from the preceding broker-adapter assessment.
calls.length = 0;
const result = await new MissionOrchestrator().assessDurableMissionRecovery({
  scope, missionId: "mission-1", persistence,
  evidenceReader: {
    async listForExecution(binding) { evidenceCalls.push(binding); return []; },
  },
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

let missingEvidenceReaderDenied = false;
try {
  await assessPersistedMissionRecovery(scope, "mission-1", persistence);
} catch (error) {
  missingEvidenceReaderDenied = error instanceof Error &&
    error.message === "MISSION_RECOVERY_EVIDENCE_READER_REQUIRED";
}
if (!missingEvidenceReaderDenied) {
  throw new Error("Outbox-bound ambiguous execution must fail closed when its evidence reader is missing.");
}

let mismatchedEvidenceDenied = false;
try {
  await assessPersistedMissionRecovery(scope, "mission-1", persistence, {
    async listForExecution() {
      return [{
        evidenceId: "evidence-1", outboxId: "different-outbox",
        idempotencyKey: "key-1", providerId: "provider-1",
        observationStatus: "SUCCEEDED", observedAt: "2026-11-22T00:00:00.000Z",
        observation: { status: "SUCCEEDED" },
      }];
    },
  });
} catch (error) {
  mismatchedEvidenceDenied = error instanceof Error &&
    error.message === "MISSION_RECOVERY_EVIDENCE_BINDING_INVALID";
}
if (!mismatchedEvidenceDenied) {
  throw new Error("Recovery must reject evidence bound to a different outbox.");
}

let contradictoryEvidenceDenied = false;
try {
  await assessPersistedMissionRecovery(scope, "mission-1", persistence, {
    async listForExecution() {
      return [{
        evidenceId: "evidence-contradictory", outboxId: "outbox-1",
        idempotencyKey: "key-1", providerId: "provider-1",
        observationStatus: "SUCCEEDED", observedAt: "2026-11-22T00:00:00.000Z",
        observation: { status: "FAILED", providerRequestId: "remote-1" },
      }];
    },
  });
} catch (error) {
  contradictoryEvidenceDenied = error instanceof Error &&
    error.message === "MISSION_RECOVERY_EVIDENCE_BINDING_INVALID";
}
if (!contradictoryEvidenceDenied) {
  throw new Error("Recovery must reject persisted evidence whose status contradicts its observation payload.");
}

let contradictoryWorkerEvidenceDenied = false;
const contradictoryWorkerReader = createWorkerBrokerRecoveryEvidenceReader({
  async listReconciliationEvidence(input) {
    return [{
      evidenceId: "evidence-contradictory", outboxId: input.outboxId,
      idempotencyKey: "key-1", providerId: "provider-1",
      observationStatus: "SUCCEEDED" as const,
      observedAt: "2026-11-22T00:00:00.000Z",
      observation: { status: "FAILED", providerRequestId: "remote-1" },
    }];
  },
}, {
  workerPrincipalId: "worker-1",
  organizationId: scope.organizationId,
  workspaceId: scope.workspaceId,
  userId: scope.userId,
}, scope);
try {
  await contradictoryWorkerReader.listForExecution({
    outboxId: "outbox-1", missionId: "mission-1",
    taskId: "task-1", executionRequestId: "execution-1",
  });
} catch (error) {
  contradictoryWorkerEvidenceDenied = error instanceof Error &&
    error.message === "MISSION_RECOVERY_EVIDENCE_BINDING_INVALID";
}
if (!contradictoryWorkerEvidenceDenied) {
  throw new Error("Worker evidence adapter must reject status/payload contradictions.");
}

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

const makeProviderEvidence = (
  evidenceId: string,
  observationStatus: "SUCCEEDED" | "FAILED" | "PROCESSING" | "NOT_FOUND" | "UNKNOWN",
  observation: Record<string, string>,
  providerId = "provider-1",
  idempotencyKey = "key-1",
) => ({
  evidenceId,
  outboxId: "outbox-1",
  idempotencyKey,
  providerId,
  observationStatus,
  observedAt: "2026-11-22T00:00:00.000Z",
  observation,
});
const classifyProviderEvidence = async (rows: ReturnType<typeof makeProviderEvidence>[]) => {
  const assessed = await assessPersistedMissionRecovery(scope, "mission-1", persistence, {
    async listForExecution() { return rows; },
  });
  return assessed.providerRecoveryByTask["task-1"];
};

const successEvidence = await classifyProviderEvidence([
  makeProviderEvidence("success-1", "SUCCEEDED", { status: "SUCCEEDED", providerRequestId: "remote-1" }),
]);
if (successEvidence?.disposition !== "VERIFICATION_REQUIRED" ||
    successEvidence.providerRequestId !== "remote-1" ||
    result.assessments[0]?.disposition !== "EXECUTION_OUTCOME_UNKNOWN") {
  throw new Error("Provider success must require application verification and must not complete the task.");
}
const failedEvidence = await classifyProviderEvidence([
  makeProviderEvidence("failed-1", "FAILED", { status: "FAILED", providerRequestId: "remote-1", code: "DECLINED", message: "Rejected" }),
]);
if (failedEvidence?.disposition !== "FAILED_EXECUTION_REVIEW_REQUIRED") {
  throw new Error("Definitive provider failure must be routed to failure review.");
}
const processingEvidence = await classifyProviderEvidence([
  makeProviderEvidence("processing-1", "PROCESSING", { status: "PROCESSING", providerRequestId: "remote-1" }),
]);
if (processingEvidence?.disposition !== "PROVIDER_STILL_PROCESSING") {
  throw new Error("A processing provider request must remain pending reconciliation.");
}
const notFoundEvidence = await classifyProviderEvidence([
  makeProviderEvidence("not-found-1", "NOT_FOUND", { status: "NOT_FOUND" }),
]);
if (notFoundEvidence?.disposition !== "NO_PROVIDER_RECORD_REVIEW_REQUIRED") {
  throw new Error("Provider NOT_FOUND must require review and must never authorize replay.");
}
const unknownEvidence = await classifyProviderEvidence([
  makeProviderEvidence("unknown-1", "UNKNOWN", { status: "UNKNOWN", reason: "Provider unavailable" }),
]);
if (unknownEvidence?.disposition !== "RECONCILIATION_REQUIRED") {
  throw new Error("Unknown provider status must remain in reconciliation.");
}
const conflictingEvidence = await classifyProviderEvidence([
  makeProviderEvidence("conflict-1", "SUCCEEDED", { status: "SUCCEEDED", providerRequestId: "remote-1" }),
  makeProviderEvidence("conflict-2", "FAILED", { status: "FAILED", providerRequestId: "remote-1" }),
]);
if (conflictingEvidence?.disposition !== "CONFLICTING_PROVIDER_EVIDENCE_REVIEW_REQUIRED") {
  throw new Error("Contradictory append-only provider observations must be routed to manual review.");
}
const mismatchedProviderEvidence = await classifyProviderEvidence([
  makeProviderEvidence("provider-a", "SUCCEEDED", { status: "SUCCEEDED", providerRequestId: "remote-1" }, "provider-a"),
  makeProviderEvidence("provider-b", "SUCCEEDED", { status: "SUCCEEDED", providerRequestId: "remote-1" }, "provider-b"),
]);
if (mismatchedProviderEvidence?.disposition !== "CONFLICTING_PROVIDER_EVIDENCE_REVIEW_REQUIRED") {
  throw new Error("Evidence from different provider accounts must not be combined.");
}
const mismatchedKeyEvidence = await classifyProviderEvidence([
  makeProviderEvidence("key-a", "SUCCEEDED", { status: "SUCCEEDED", providerRequestId: "remote-1" }, "provider-1", "key-a"),
  makeProviderEvidence("key-b", "SUCCEEDED", { status: "SUCCEEDED", providerRequestId: "remote-1" }, "provider-1", "key-b"),
]);
if (mismatchedKeyEvidence?.disposition !== "CONFLICTING_PROVIDER_EVIDENCE_REVIEW_REQUIRED") {
  throw new Error("Evidence for different idempotency keys must not be combined.");
}
const emptyEvidence = await classifyProviderEvidence([]);
if (emptyEvidence?.disposition !== "NO_EVIDENCE_RECORDED" || emptyEvidence.evidenceCount !== 0) {
  throw new Error("An empty evidence set must remain explicitly unresolved.");
}

console.log("Persisted mission recovery assessment: PASS");

}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
