import type {
  EntityType,
  PersistedRecord,
  Repository,
  RepositoryQuery,
} from "../types";

export class InMemoryRepository<T> implements Repository<T> {
  private readonly records = new Map<string, PersistedRecord<T>>();

  create(
    entityType: EntityType,
    id: string,
    data: T,
  ): PersistedRecord<T> {
    if (this.records.has(id)) {
      throw new Error(`Record already exists: ${id}`);
    }

    const now = new Date().toISOString();

    const record: PersistedRecord<T> = {
      id,
      entityType,
      version: 1,
      createdAt: now,
      updatedAt: now,
      data,
    };

    this.records.set(id, record);
    return record;
  }

  get(id: string): PersistedRecord<T> | undefined {
    return this.records.get(id);
  }

  list(query: RepositoryQuery = {}): PersistedRecord<T>[] {
    let result = [...this.records.values()];

    if (query.id) {
      result = result.filter((record) => record.id === query.id);
    }

    if (query.entityType) {
      result = result.filter(
        (record) => record.entityType === query.entityType,
      );
    }

    if (query.limit !== undefined) {
      result = result.slice(0, query.limit);
    }

    return result;
  }

  update(
    id: string,
    data: T,
  ): PersistedRecord<T> {
    const existing = this.records.get(id);

    if (!existing) {
      throw new Error(`Record not found: ${id}`);
    }

    const updated: PersistedRecord<T> = {
      ...existing,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
      data,
    };

    this.records.set(id, updated);
    return updated;
  }

  delete(id: string): boolean {
    return this.records.delete(id);
  }

  count(entityType?: EntityType): number {
    if (!entityType) {
      return this.records.size;
    }

    return this.list({ entityType }).length;
  }
}

