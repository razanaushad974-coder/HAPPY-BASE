import type { TenantScope } from "../../state/types";
import type { EntityType } from "../types";
import {
  TenantPersistenceError,
  TenantBoundTransactionAdapter,
  type AsyncTenantPersistenceAdapter,
  type TenantPersistedRecord,
  type TenantRecordQuery,
} from "../async-tenant-repository";

type CompleteScope = TenantScope & { userId: string };

function key(
  scope: CompleteScope,
  entityType: EntityType,
  id: string,
): string {
  return JSON.stringify([
    scope.organizationId,
    scope.workspaceId,
    scope.userId,
    entityType,
    id,
  ]);
}

/**
 * Deterministic in-memory adapter for tests and local contract development.
 * It is NOT durable and must never be registered as a production provider.
 */
export class InMemoryTenantPersistenceAdapter implements AsyncTenantPersistenceAdapter {
  private records = new Map<string, TenantPersistedRecord<unknown>>();

  async get<T>(
    scope: CompleteScope,
    entityType: EntityType,
    id: string,
  ): Promise<TenantPersistedRecord<T> | undefined> {
    const record = this.records.get(key(scope, entityType, id));
    return record ? structuredClone(record as TenantPersistedRecord<T>) : undefined;
  }

  async list<T>(
    scope: CompleteScope,
    query: TenantRecordQuery = {},
  ): Promise<TenantPersistedRecord<T>[]> {
    const prefix = [scope.organizationId, scope.workspaceId, scope.userId];
    const rows = [...this.records.entries()]
      .filter(([recordKey, record]) => {
        const parts = JSON.parse(recordKey) as unknown[];
        return parts[0] === prefix[0] &&
          parts[1] === prefix[1] &&
          parts[2] === prefix[2] &&
          (!query.entityType || record.entityType === query.entityType);
      })
      .map(([, record]) => structuredClone(record as TenantPersistedRecord<T>));
    return query.limit === undefined ? rows : rows.slice(0, Math.max(0, query.limit));
  }

  async create<T>(
    scope: CompleteScope,
    entityType: EntityType,
    id: string,
    data: T,
  ): Promise<TenantPersistedRecord<T>> {
    const recordKey = key(scope, entityType, id);
    if (this.records.has(recordKey)) {
      throw new TenantPersistenceError("RECORD_ALREADY_EXISTS");
    }
    const now = new Date().toISOString();
    const record: TenantPersistedRecord<T> = {
      id, entityType, version: 1, createdAt: now, updatedAt: now,
      organizationId: scope.organizationId,
      workspaceId: scope.workspaceId,
      userId: scope.userId,
      data: structuredClone(data),
    };
    this.records.set(recordKey, record);
    return structuredClone(record);
  }

  async update<T>(
    scope: CompleteScope,
    entityType: EntityType,
    id: string,
    expectedVersion: number,
    data: T,
  ): Promise<TenantPersistedRecord<T>> {
    const recordKey = key(scope, entityType, id);
    const existing = this.records.get(recordKey);
    if (!existing) throw new TenantPersistenceError("RECORD_NOT_FOUND");
    if (existing.version !== expectedVersion) {
      throw new TenantPersistenceError("VERSION_CONFLICT");
    }
    const updated: TenantPersistedRecord<T> = {
      ...existing,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
      data: structuredClone(data),
    };
    this.records.set(recordKey, updated);
    return structuredClone(updated);
  }

  async delete(
    scope: CompleteScope,
    entityType: EntityType,
    id: string,
    expectedVersion: number,
  ): Promise<boolean> {
    const recordKey = key(scope, entityType, id);
    const existing = this.records.get(recordKey);
    if (!existing) return false;
    if (existing.version !== expectedVersion) {
      throw new TenantPersistenceError("VERSION_CONFLICT");
    }
    return this.records.delete(recordKey);
  }

  async transaction<T>(
    scope: CompleteScope,
    operation: (transaction: AsyncTenantPersistenceAdapter) => Promise<T>,
  ): Promise<T> {
    if (!scope.organizationId.trim() || !scope.workspaceId.trim() || !scope.userId.trim()) {
      throw new TenantPersistenceError("INVALID_TENANT_SCOPE");
    }
    // Test-only snapshot transaction: commit the cloned state only on success.
    // This does not claim PostgreSQL isolation or concurrency semantics.
    const transactionAdapter = new InMemoryTenantPersistenceAdapter();
    transactionAdapter.records = new Map(
      [...this.records.entries()].map(([recordKey, record]) => [
        recordKey,
        structuredClone(record),
      ]),
    );
    const boundTransaction = new TenantBoundTransactionAdapter(scope, transactionAdapter);
    const result = await operation(boundTransaction);
    this.records = transactionAdapter.records;
    return result;
  }
}
