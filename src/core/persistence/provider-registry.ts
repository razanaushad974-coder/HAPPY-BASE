import type {
  PersistenceConfig,
  PersistenceProvider,
  PersistenceStatus,
  PersistenceDurabilityScope,
} from "./types";

export interface PersistenceProviderEntry {
  provider: PersistenceProvider;
  status: PersistenceStatus;
  durable: boolean;
  durabilityScope: PersistenceDurabilityScope;
}

export class PersistenceProviderRegistry {
  private readonly providers: PersistenceProviderEntry[] = [
    {
      provider: "MEMORY",
      status: "AVAILABLE",
      durable: false,
      durabilityScope: "PROCESS_LOCAL",
    },
    {
      provider: "FILE",
      status: "AVAILABLE",
      durable: true,
      durabilityScope: "SINGLE_HOST_FILE",
    },
    {
      provider: "POSTGRES",
      status: "NOT_YET_CONNECTED",
      durable: false,
      durabilityScope: "NOT_CONNECTED",
    },
    {
      provider: "SUPABASE",
      status: "NOT_YET_CONNECTED",
      durable: false,
      durabilityScope: "NOT_CONNECTED",
    },
    {
      provider: "SQLITE",
      status: "NOT_YET_CONNECTED",
      durable: false,
      durabilityScope: "NOT_CONNECTED",
    },
  ];

  get(provider: PersistenceProvider): PersistenceProviderEntry {
    const entry = this.providers.find(
      (item) => item.provider === provider,
    );

    if (!entry) {
      throw new Error(
        `Persistence provider not registered: ${provider}`,
      );
    }

    return entry;
  }

  config(provider: PersistenceProvider): PersistenceConfig {
    const entry = this.get(provider);

    return {
      provider: entry.provider,
      status: entry.status,
      connectionConfigured: entry.status === "AVAILABLE",
      durable: entry.durable,
      durabilityScope: entry.durabilityScope,
    };
  }

  list(): PersistenceProviderEntry[] {
    return [...this.providers];
  }
}
