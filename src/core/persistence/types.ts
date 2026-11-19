export type PersistenceProvider =
  | "MEMORY"
  | "FILE"
  | "POSTGRES"
  | "SUPABASE"
  | "SQLITE";

export type PersistenceStatus =
  | "AVAILABLE"
  | "NOT_YET_CONNECTED"
  | "DISABLED"
  | "ERROR";

export type EntityType =
  | "USER"
  | "WORKSPACE"
  | "PROJECT"
  | "COMMAND"
  | "MISSION"
  | "TASK"
  | "EXECUTION"
  | "VERIFICATION"
  | "VERIFICATION_REQUEST"
  | "EVIDENCE"
  | "MEMORY"
  | "APPROVAL"
  | "AUDIT_EVENT";

export type PersistenceDurabilityScope =
  | "PROCESS_LOCAL"
  | "SINGLE_HOST_FILE"
  | "TRANSACTIONAL_DATABASE"
  | "NOT_CONNECTED";

export interface PersistenceConfig {
  provider: PersistenceProvider;
  status: PersistenceStatus;
  databaseName?: string;
  schemaName?: string;
  connectionConfigured: boolean;
  /** Whether the selected provider is designed to persist data beyond process memory. */
  durable: boolean;
  /** Operational scope of that durability; not a claim that the provider is connected. */
  durabilityScope?: PersistenceDurabilityScope;
}

export interface PersistedRecord<T> {
  id: string;
  entityType: EntityType;
  version: number;
  createdAt: string;
  updatedAt: string;
  data: T;
}

export interface RepositoryQuery {
  id?: string;
  entityType?: EntityType;
  limit?: number;
}

export interface Repository<T> {
  create(
    entityType: EntityType,
    id: string,
    data: T,
  ): PersistedRecord<T>;

  get(id: string): PersistedRecord<T> | undefined;

  list(query?: RepositoryQuery): PersistedRecord<T>[];

  update(
    id: string,
    data: T,
  ): PersistedRecord<T>;

  delete(id: string): boolean;

  count(entityType?: EntityType): number;
}
