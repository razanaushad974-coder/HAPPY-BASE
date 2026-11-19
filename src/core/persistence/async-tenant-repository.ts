import type { EntityType, PersistedRecord } from "./types";
import type { TenantScope } from "../state/types";

export interface TenantPersistedRecord<T> extends PersistedRecord<T> {
  organizationId: string;
  workspaceId: string;
  userId: string;
}

export interface TenantRecordQuery {
  entityType?: EntityType;
  limit?: number;
}

export type TenantPersistenceFailureCode =
  | "RECORD_NOT_FOUND"
  | "RECORD_ALREADY_EXISTS"
  | "VERSION_CONFLICT"
  | "INVALID_TENANT_SCOPE"
  | "PERSISTENCE_NOT_CONNECTED";

export class TenantPersistenceError extends Error {
  constructor(
    readonly code: TenantPersistenceFailureCode,
    message: string = code,
  ) {
    super(message);
    this.name = "TenantPersistenceError";
  }
}

/**
 * Asynchronous, tenant-first persistence contract.
 *
 * Implementations must constrain every operation by organization, workspace,
 * and user at the storage boundary. Implementations must not fetch a global
 * collection and filter it in application memory.
 */
export interface AsyncTenantPersistenceAdapter {
  get<T>(
    scope: TenantScope & { userId: string },
    entityType: EntityType,
    id: string,
  ): Promise<TenantPersistedRecord<T> | undefined>;

  list<T>(
    scope: TenantScope & { userId: string },
    query?: TenantRecordQuery,
  ): Promise<TenantPersistedRecord<T>[]>;

  create<T>(
    scope: TenantScope & { userId: string },
    entityType: EntityType,
    id: string,
    data: T,
  ): Promise<TenantPersistedRecord<T>>;

  update<T>(
    scope: TenantScope & { userId: string },
    entityType: EntityType,
    id: string,
    expectedVersion: number,
    data: T,
  ): Promise<TenantPersistedRecord<T>>;

  delete(
    scope: TenantScope & { userId: string },
    entityType: EntityType,
    id: string,
    expectedVersion: number,
  ): Promise<boolean>;

  /** Execute a group of scoped operations atomically on one storage transaction. */
  transaction<T>(
    scope: TenantScope & { userId: string },
    operation: (transaction: AsyncTenantPersistenceAdapter) => Promise<T>,
  ): Promise<T>;
}

export function requireCompleteScope(
  scope: TenantScope,
): asserts scope is TenantScope & { userId: string } {
  if (
    !scope.organizationId.trim() ||
    !scope.workspaceId.trim() ||
    !scope.userId?.trim()
  ) {
    throw new TenantPersistenceError(
      "INVALID_TENANT_SCOPE",
      "Organization, workspace, and authenticated user are required.",
    );
  }
}


/**
 * Restricts a transaction callback to the exact tenant scope that opened it.
 * A transaction callback must never receive an adapter that can be redirected
 * to another organization, workspace, or user by supplying a different scope.
 */
export class TenantBoundTransactionAdapter implements AsyncTenantPersistenceAdapter {
  constructor(
    private readonly scope: TenantScope & { userId: string },
    private readonly adapter: AsyncTenantPersistenceAdapter,
  ) {}

  private assertScope(scope: TenantScope & { userId: string }): void {
    if (
      scope.organizationId !== this.scope.organizationId ||
      scope.workspaceId !== this.scope.workspaceId ||
      scope.userId !== this.scope.userId
    ) {
      throw new TenantPersistenceError(
        "INVALID_TENANT_SCOPE",
        "A transaction cannot access records outside its bound tenant and principal.",
      );
    }
  }

  get<T>(scope: TenantScope & { userId: string }, entityType: EntityType, id: string) {
    this.assertScope(scope);
    return this.adapter.get<T>(this.scope, entityType, id);
  }

  list<T>(scope: TenantScope & { userId: string }, query?: TenantRecordQuery) {
    this.assertScope(scope);
    return this.adapter.list<T>(this.scope, query);
  }

  create<T>(scope: TenantScope & { userId: string }, entityType: EntityType, id: string, data: T) {
    this.assertScope(scope);
    return this.adapter.create(this.scope, entityType, id, data);
  }

  update<T>(scope: TenantScope & { userId: string }, entityType: EntityType, id: string, expectedVersion: number, data: T) {
    this.assertScope(scope);
    return this.adapter.update(this.scope, entityType, id, expectedVersion, data);
  }

  delete(scope: TenantScope & { userId: string }, entityType: EntityType, id: string, expectedVersion: number) {
    this.assertScope(scope);
    return this.adapter.delete(this.scope, entityType, id, expectedVersion);
  }

  transaction<T>(
    scope: TenantScope & { userId: string },
    operation: (transaction: AsyncTenantPersistenceAdapter) => Promise<T>,
  ): Promise<T> {
    this.assertScope(scope);
    return this.adapter.transaction(this.scope, async (transaction) =>
      operation(new TenantBoundTransactionAdapter(this.scope, transaction)),
    );
  }
}

/**
 * Tenant-aware repository facade. It refuses to operate without a complete
 * principal scope and requires an expected version for every mutation after
 * creation. A remote adapter must implement update/delete as atomic
 * conditional writes, not read-then-write sequences.
 */
export class AsyncTenantScopedRepository<T> {
  private readonly scope: TenantScope & { userId: string };

  constructor(
    private readonly entityType: EntityType,
    scope: TenantScope,
    private readonly adapter: AsyncTenantPersistenceAdapter,
  ) {
    requireCompleteScope(scope);
    this.scope = { ...scope, userId: scope.userId };
  }

  create(id: string, data: T): Promise<TenantPersistedRecord<T>> {
    return this.adapter.create(this.scope, this.entityType, id, data);
  }

  get(id: string): Promise<TenantPersistedRecord<T> | undefined> {
    return this.adapter.get(this.scope, this.entityType, id);
  }

  list(query: Omit<TenantRecordQuery, "entityType"> = {}): Promise<TenantPersistedRecord<T>[]> {
    return this.adapter.list(this.scope, { ...query, entityType: this.entityType });
  }

  update(
    id: string,
    expectedVersion: number,
    data: T,
  ): Promise<TenantPersistedRecord<T>> {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new TenantPersistenceError("VERSION_CONFLICT", "A valid expected version is required.");
    }
    return this.adapter.update(this.scope, this.entityType, id, expectedVersion, data);
  }

  delete(id: string, expectedVersion: number): Promise<boolean> {
    if (!Number.isInteger(expectedVersion) || expectedVersion < 1) {
      throw new TenantPersistenceError("VERSION_CONFLICT", "A valid expected version is required.");
    }
    return this.adapter.delete(this.scope, this.entityType, id, expectedVersion);
  }
}
