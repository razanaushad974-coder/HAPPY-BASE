import {
  AsyncTenantScopedRepository,
  TenantPersistenceError,
} from "../../../core/persistence/async-tenant-repository";
import { InMemoryTenantPersistenceAdapter } from "../../../core/persistence/adapters/in-memory-tenant-adapter";

async function main(): Promise<void> {
  const adapter = new InMemoryTenantPersistenceAdapter();
  const scopeA = { organizationId: "org-a", workspaceId: "ws-a", userId: "user-a" };
  const scopeB = { organizationId: "org-a", workspaceId: "ws-a", userId: "user-b" };
  const repoA = new AsyncTenantScopedRepository<{ value: string }>("MISSION", scopeA, adapter);
  const repoB = new AsyncTenantScopedRepository<{ value: string }>("MISSION", scopeB, adapter);

  const created = await repoA.create("mission-1", { value: "initial" });
  if (created.version !== 1 || created.userId !== "user-a") {
    throw new Error("Create must persist the complete tenant and principal scope.");
  }
  if (await repoB.get("mission-1")) {
    throw new Error("A different user principal must not read the record.");
  }
  if ((await repoB.list()).length !== 0) {
    throw new Error("A different user principal must not list the record.");
  }

  const updated = await repoA.update("mission-1", 1, { value: "updated" });
  if (updated.version !== 2 || updated.data.value !== "updated") {
    throw new Error("Update must increment the persisted version.");
  }

  let staleConflict = false;
  try {
    await repoA.update("mission-1", 1, { value: "stale write" });
  } catch (error) {
    staleConflict = error instanceof TenantPersistenceError &&
      error.code === "VERSION_CONFLICT";
  }
  if (!staleConflict) throw new Error("A stale expected version must conflict.");

  const concurrent = await Promise.allSettled([
    repoA.update("mission-1", 2, { value: "winner-a" }),
    repoA.update("mission-1", 2, { value: "winner-b" }),
  ]);
  if (concurrent.filter((item) => item.status === "fulfilled").length !== 1) {
    throw new Error("Exactly one concurrent update may win for a given version.");
  }
  if (concurrent.filter((item) => item.status === "rejected").length !== 1) {
    throw new Error("The losing concurrent update must be rejected.");
  }

  const latest = await repoA.get("mission-1");
  if (!latest || latest.version !== 3) {
    throw new Error("The winning update must be visible at the next version.");
  }

  const deleted = await repoA.delete("mission-1", 3);
  if (!deleted || await repoA.get("mission-1")) {
    throw new Error("Delete must require the current version and remove the row.");
  }

  let missingUserDenied = false;
  try {
    new AsyncTenantScopedRepository("MISSION", {
      organizationId: "org-a",
      workspaceId: "ws-a",
    }, adapter);
  } catch (error) {
    missingUserDenied = error instanceof TenantPersistenceError &&
      error.code === "INVALID_TENANT_SCOPE";
  }
  if (!missingUserDenied) throw new Error("A missing authenticated user must fail closed.");

  console.log("Async tenant repository contract: PASS");
  console.log({
    principalIsolation: true,
    tenantScopedListing: true,
    optimisticConcurrency: true,
    concurrentSingleWinner: true,
    versionedDelete: true,
    missingPrincipalDenied: true,
    adapterDurability: "IN_MEMORY_TEST_ONLY",
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
