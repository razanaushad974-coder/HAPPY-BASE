import { PersistenceProviderRegistry } from "../../../core/persistence/provider-registry";

function main(): void {
  const registry = new PersistenceProviderRegistry();
  const memory = registry.config("MEMORY");
  const file = registry.config("FILE");
  const postgres = registry.config("POSTGRES");
  const supabase = registry.config("SUPABASE");
  const sqlite = registry.config("SQLITE");

  if (memory.durable || memory.durabilityScope !== "PROCESS_LOCAL") {
    throw new Error("Memory persistence must be identified as process-local and non-durable.");
  }
  if (!file.durable || file.durabilityScope !== "SINGLE_HOST_FILE") {
    throw new Error("File persistence must be described as single-host, not database durability.");
  }
  for (const config of [postgres, supabase, sqlite]) {
    if (config.status !== "NOT_YET_CONNECTED" || config.connectionConfigured ||
        config.durable || config.durabilityScope !== "NOT_CONNECTED") {
      throw new Error(`${config.provider} must not claim connected or available durability.`);
    }
  }

  console.log("Persistence provider durability contract: PASS");
  console.log({
    memory: memory.durabilityScope,
    file: file.durabilityScope,
    postgres: postgres.durabilityScope,
    supabase: supabase.durabilityScope,
    sqlite: sqlite.durabilityScope,
  });
}

main();
