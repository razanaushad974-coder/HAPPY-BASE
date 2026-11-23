import { ReasoningOrchestrator } from "../../../core/reasoning/orchestrator";
import { MissionOrchestrator } from "../../../core/mission/orchestrator";
import { InMemoryTenantPersistenceAdapter } from "../../../core/persistence/adapters/in-memory-tenant-adapter";

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
