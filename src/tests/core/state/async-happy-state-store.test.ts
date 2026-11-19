import { TenantPersistenceError } from "../../../core/persistence/async-tenant-repository";
import { InMemoryTenantPersistenceAdapter } from "../../../core/persistence/adapters/in-memory-tenant-adapter";
import { createAsyncHappyStateStore } from "../../../core/state/async-factory";

async function main(): Promise<void> {
  const adapter = new InMemoryTenantPersistenceAdapter();
  const owner = createAsyncHappyStateStore(adapter, "org-a", "workspace-a", "user-a");
  const otherUser = createAsyncHappyStateStore(adapter, "org-a", "workspace-a", "user-b");

  const mission = await owner.mission<{ goal: string }>().create("mission-1", {
    goal: "Resume HAPPY mission safely",
  });
  if (mission.entityType !== "MISSION" || mission.version !== 1 ||
      mission.organizationId !== "org-a" || mission.workspaceId !== "workspace-a" ||
      mission.userId !== "user-a") {
    throw new Error("Async state store did not preserve mission entity and complete tenant scope.");
  }

  if (await otherUser.mission().get("mission-1")) {
    throw new Error("Async state store exposed another user's mission.");
  }

  const updated = await owner.mission<{ goal: string }>().update(
    "mission-1",
    mission.version,
    { goal: "Resume and verify HAPPY mission" },
  );
  if (updated.version !== 2 || updated.data.goal !== "Resume and verify HAPPY mission") {
    throw new Error("Async state store versioned update failed.");
  }

  let staleConflict = false;
  try {
    await owner.mission().update("mission-1", 1, { goal: "stale" });
  } catch (error) {
    staleConflict = error instanceof TenantPersistenceError &&
      error.code === "VERSION_CONFLICT";
  }
  if (!staleConflict) throw new Error("Async state store accepted a stale mission write.");

  await owner.task().create("task-1", { missionId: "mission-1", status: "PENDING" });
  await owner.memory().create("memory-1", { key: "mission-context", value: "verified" });
  if ((await owner.task().list()).length !== 1 ||
      (await owner.memory().list()).length !== 1 ||
      (await owner.mission().list()).length !== 1) {
    throw new Error("Async state store entity collections were not isolated.");
  }

  const deleted = await owner.mission().delete("mission-1", updated.version);
  if (!deleted || await owner.mission().get("mission-1")) {
    throw new Error("Async state store versioned delete failed.");
  }

  console.log("Async HAPPY state store contract: PASS");
  console.log({
    entityScopedRepositories: true,
    completeTenantScope: true,
    principalIsolation: true,
    optimisticConcurrency: true,
    versionedDelete: true,
    adapterDurability: "IN_MEMORY_TEST_ONLY",
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
