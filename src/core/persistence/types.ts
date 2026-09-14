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
  | "EVIDENCE"
  | "MEMORY"
  | "APPROVAL"
  | "AUDIT_EVENT";

export interface PersistenceConfig {
  provider: PersistenceProvider;
  status: PersistenceStatus;
  databaseName?: string;
  schemaName?: string;
  connectionConfigured: boolean;
  durable: boolean;
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
