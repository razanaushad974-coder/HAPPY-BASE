import { ReasoningOrchestrator } from "../../../core/reasoning/orchestrator";
import { MissionOrchestrator } from "../../../core/mission/orchestrator";
import { InMemoryTenantPersistenceAdapter } from "../../../core/persistence/adapters/in-memory-tenant-adapter";
import { createAsyncHappyStateStore } from "../../../core/state/async-factory";
import { AsyncEvidenceService } from "../../../core/evidence/async-service";
import { AsyncVerificationService } from "../../../core/verification/async-service";

async function main(): Promise<void> {
  const reasoning = new ReasoningOrchestrator();
  const orchestrator = new MissionOrchestrator();
  const persistence = new InMemoryTenantPersistenceAdapter();
  const scope = { organizationId: "org-durable", workspaceId: "ws-durable", userId: "user-durable" };
  const otherUser = { ...scope, userId: "user-other" };

  const plan = reasoning.createExecutionPlan({ goal: "Create a durable mission record." });
  if (plan.status !== "READY") throw new Error("Expected a READY plan for durable creation.");

  const snapshot = await orchestrator.createDurable(plan, scope, persistence);
  const mission = await persistence.get<{ id: string }>(scope, "MISSION", snapshot.mission.id);
  const tasks = await persistence.list(otherUser, { entityType: "TASK" });
  const ownTasks = await persistence.list(scope, { entityType: "TASK" });

  if (!mission || mission.version !== 1 || mission.data.id !== snapshot.mission.id) {
    throw new Error("Durable mission record was not created at version 1.");
  }
  if (ownTasks.length !== snapshot.graph.tasks.length) {
    throw new Error("The complete mission task graph was not persisted.");
  }
  if (tasks.length !== 0) {
    throw new Error("A different user principal must not list durable mission tasks.");
  }

  let missingPrincipalDenied = false;
  try {
    await orchestrator.createDurable(plan, {
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
    }, persistence);
  } catch {
    missingPrincipalDenied = true;
  }
  if (!missingPrincipalDenied) throw new Error("Durable mission creation accepted a missing user principal.");

  const scheduled = await orchestrator.runNextReadyMissionTaskDispatch({
    persistence,
    scope,
    tenantScope: {
      workerPrincipalId: "worker-principal-not-connected",
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      userId: scope.userId,
    },
    ownerId: "worker-instance-not-connected",
    leaseMilliseconds: 30_000,
    provider: {
      providerId: "must-not-run-without-worker-identity",
      supportsIdempotencyKeys: true,
      async dispatch() {
        throw new Error("provider must not run before trusted worker identity is connected");
      },
    },
  });
  if (scheduled.status !== "NOT_CONNECTED" || scheduled.missing !== "IDENTITY_PROVIDER") {
    throw new Error("Durable scheduler did not select a dependency-ready task and fail closed at the trusted worker gate.");
  }

  const rootTaskId = snapshot.graph.roots[0];
  if (!rootTaskId) throw new Error("Durable mission did not persist a root task.");
  const running = await orchestrator.transitionTaskDurable({
    scope, persistence, missionId: snapshot.mission.id, taskId: rootTaskId, status: "RUNNING",
  });
  const persistedRunningTask = await persistence.get<{ status: string }>(scope, "TASK", rootTaskId);
  const persistedRunningMission = await persistence.get<{ status: string }>(scope, "MISSION", snapshot.mission.id);
  if (running.mission.status !== "RUNNING" || persistedRunningTask?.data.status !== "RUNNING" ||
      persistedRunningTask.version !== 2 || persistedRunningMission?.data.status !== "RUNNING") {
    throw new Error("Durable task transition did not atomically persist task and mission state.");
  }

  const dependentTask = snapshot.graph.tasks.find((task) => task.dependencyIds.length > 0);
  if (dependentTask) {
    let prematureStartDenied = false;
    try {
      await orchestrator.transitionTaskDurable({
        scope, persistence, missionId: snapshot.mission.id,
        taskId: dependentTask.id, status: "RUNNING",
      });
    } catch {
      prematureStartDenied = true;
    }
    if (!prematureStartDenied) throw new Error("Durable transition allowed a dependent task to start early.");
  }

  const verifying = await orchestrator.transitionTaskDurable({
    scope, persistence, missionId: snapshot.mission.id, taskId: rootTaskId, status: "VERIFYING",
  });
  if (verifying.graph.tasks.find((task) => task.id === rootTaskId)?.status !== "VERIFYING") {
    throw new Error("Durable task transition to VERIFYING failed.");
  }
  const rootTask = snapshot.graph.tasks.find((task) => task.id === rootTaskId);
  if (!rootTask) throw new Error("Persisted root task disappeared from the graph.");

  let unverifiedCompletionDenied = false;
  try {
    await orchestrator.transitionTaskDurable({
      scope, persistence, missionId: snapshot.mission.id, taskId: rootTaskId, status: "COMPLETED",
    });
  } catch {
    unverifiedCompletionDenied = true;
  }
  if (rootTask.verificationRequired && !unverifiedCompletionDenied) {
    throw new Error("A verification-required task completed without persisted PASSED verification evidence.");
  }

  const verificationRequestId = `verification-${rootTaskId}`;
  const verificationStore = createAsyncHappyStateStore(
    persistence, scope.organizationId, scope.workspaceId, scope.userId,
  );
  const evidenceService = new AsyncEvidenceService(verificationStore);
  const verificationService = new AsyncVerificationService(verificationStore);
  await verificationService.registerRequest({
    id: verificationRequestId,
    missionId: snapshot.mission.id,
    taskId: rootTaskId,
    description: "Verify the durable root task.",
    criteria: [{
      id: "criterion-1", description: "Result verified",
      expected: "PASS", required: true,
    }],
    preferredMethods: ["TEST"],
    requiresEvidence: true,
    createdAt: new Date().toISOString(),
  });
  const capturedEvidence = await evidenceService.capture({
    verificationRequestId,
    missionId: snapshot.mission.id,
    taskId: rootTaskId,
    type: "TEST_RESULT",
    source: "TEST",
    title: "Durable task verification evidence",
    content: "Synthetic evidence only; it does not prove the criterion.",
  });
  const persistedVerification = await verificationService.verify(
    verificationRequestId, [capturedEvidence.id],
  );
  if (persistedVerification.status !== "PARTIAL" ||
      persistedVerification.failureReason !== "SEMANTIC_VERIFIER_NOT_CONNECTED") {
    throw new Error("Evidence capture must not be upgraded to semantic verification success.");
  }

  let partialVerificationCompletionDenied = false;
  try {
    await orchestrator.transitionTaskDurable({
      scope, persistence, missionId: snapshot.mission.id,
      taskId: rootTaskId, status: "COMPLETED", verificationRequestId,
    });
  } catch {
    partialVerificationCompletionDenied = true;
  }
  const stillVerifyingTask = await persistence.get<{ status: string }>(
    scope, "TASK", rootTaskId,
  );
  if (!partialVerificationCompletionDenied ||
      stillVerifyingTask?.data.status !== "VERIFYING") {
    throw new Error("A PARTIAL verification result must not complete or mutate the task.");
  }

  let rollbackVerified = false;
  const rollbackId = "rollback-probe";
  try {
    await persistence.transaction(scope, async (tx) => {
      await tx.create(scope, "MISSION", rollbackId, { id: rollbackId });
      throw new Error("force rollback");
    });
  } catch {
    rollbackVerified = !(await persistence.get(scope, "MISSION", rollbackId));
  }
  if (!rollbackVerified) throw new Error("Transaction rollback left a partial mission record.");

  console.log("Durable mission creation contract: PASS");
  console.log({
    missionPersisted: true,
    completeTaskGraphPersisted: true,
    tenantScopedReadyTaskScheduler: true,
    schedulerFailsClosedWithoutTrustedWorkerIdentity: true,
    versionedTaskAndMissionTransitions: true,
    dependencyGatePreserved: true,
    persistedVerificationRequiredBeforeCompletion: true,
    tenantPrincipalIsolation: true,
    missingPrincipalDenied: true,
    transactionRollback: true,
    adapterDurability: "IN_MEMORY_TEST_ONLY",
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
