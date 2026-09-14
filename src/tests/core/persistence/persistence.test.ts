import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";

import { JsonFileStateAdapter } from "../../../core/persistence/adapters/json-file-adapter";
import { PersistenceProviderRegistry } from "../../../core/persistence/provider-registry";
import { PersistenceService } from "../../../core/persistence/service";

async function main(): Promise<void> {
  const testDirectory = join(
    process.cwd(),
    ".happy-test-state",
  );

  const stateFile = join(
    testDirectory,
    "state.json",
  );

  if (existsSync(testDirectory)) {
    rmSync(testDirectory, {
      recursive: true,
      force: true,
    });
  }

  // --------------------------------------------------
  // FILE-BACKED PERSISTENCE
  // --------------------------------------------------

  const adapter1 = new JsonFileStateAdapter(stateFile);
  const service1 = new PersistenceService(adapter1);

  if (service1.count() !== 0) {
    throw new Error("Fresh persistent state is not empty.");
  }

  const mission = service1.create(
    "MISSION",
    "mission-persistent-1",
    {
      goal: "Persistent HAPPY mission",
      status: "READY",
    },
  );

  if (mission.version !== 1) {
    throw new Error("Initial record version is incorrect.");
  }

  const updated = service1.update(
    "MISSION",
    "mission-persistent-1",
    {
      goal: "Updated persistent HAPPY mission",
      status: "RUNNING",
    },
  );

  if (updated.version !== 2) {
    throw new Error("Record version did not increment.");
  }

  if (!existsSync(stateFile)) {
    throw new Error("Persistent state file was not created.");
  }

  // --------------------------------------------------
  // RESTART SIMULATION
  // --------------------------------------------------

  const adapter2 = new JsonFileStateAdapter(stateFile);
  const service2 = new PersistenceService(adapter2);

  const restored = service2.get<{
    goal: string;
    status: string;
  }>(
    "MISSION",
    "mission-persistent-1",
  );

  if (!restored) {
    throw new Error("Persistent record was not restored.");
  }

  if (restored.version !== 2) {
    throw new Error("Persisted version was not restored.");
  }

  if (restored.data.status !== "RUNNING") {
    throw new Error("Persisted data was not restored correctly.");
  }

  // --------------------------------------------------
  // DELETE
  // --------------------------------------------------

  if (!service2.delete("MISSION", "mission-persistent-1")) {
    throw new Error("Persistent delete failed.");
  }

  if (service2.get("MISSION", "mission-persistent-1")) {
    throw new Error("Deleted persistent record still exists.");
  }

  // --------------------------------------------------
  // PROVIDER REGISTRY
  // --------------------------------------------------

  const registry = new PersistenceProviderRegistry();

  const file = registry.config("FILE");
  const postgres = registry.config("POSTGRES");
  const supabase = registry.config("SUPABASE");

  if (file.status !== "AVAILABLE") {
    throw new Error("FILE persistence should be AVAILABLE.");
  }

  if (!file.durable) {
    throw new Error("FILE persistence must be durable.");
  }

  if (postgres.status !== "NOT_YET_CONNECTED") {
    throw new Error(
      "Postgres must remain explicitly NOT_YET_CONNECTED.",
    );
  }

  if (supabase.status !== "NOT_YET_CONNECTED") {
    throw new Error(
      "Supabase must remain explicitly NOT_YET_CONNECTED.",
    );
  }

  // --------------------------------------------------
  // CLEANUP
  // --------------------------------------------------

  if (existsSync(testDirectory)) {
    rmSync(testDirectory, {
      recursive: true,
      force: true,
    });
  }

  console.log("Persistence foundation test: PASS");
  console.log({
    providerCount: registry.list().length,
    filePersistence: file.status,
    durableFileState: file.durable,
    restartRecovery: true,
    versioning: true,
    updatePersistence: true,
    deletePersistence: true,
    postgres: postgres.status,
    supabase: supabase.status,
    fakeDatabaseConnectionPrevented:
      postgres.status === "NOT_YET_CONNECTED" &&
      supabase.status === "NOT_YET_CONNECTED",
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
