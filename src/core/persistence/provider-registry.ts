import type {
  PersistenceConfig,
  PersistenceProvider,
  PersistenceStatus,
} from "./types";

export interface PersistenceProviderEntry {
  provider: PersistenceProvider;
  status: PersistenceStatus;
  durable: boolean;
}

export class PersistenceProviderRegistry {
  private readonly providers: PersistenceProviderEntry[] = [
    {
      provider: "MEMORY",
      status: "AVAILABLE",
      durable: false,
    },
    {
      provider: "FILE",
      status: "AVAILABLE",
      durable: true,
    },
    {
      provider: "POSTGRES",
      status: "NOT_YET_CONNECTED",
      durable: true,
    },
    {
      provider: "SUPABASE",
      status: "NOT_YET_CONNECTED",
      durable: true,
    },
    {
      provider: "SQLITE",
      status: "NOT_YET_CONNECTED",
      durable: true,
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
    };
  }

  list(): PersistenceProviderEntry[] {
    return [...this.providers];
  }
}
