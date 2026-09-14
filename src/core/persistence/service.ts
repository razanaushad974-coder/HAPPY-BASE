import type { EntityType, PersistedRecord } from "./types";
import type { HappyState } from "./state";
import {
  ENTITY_STATE_KEYS,
  createEmptyState,
} from "./state";
import type { PersistentStateAdapter } from "./adapters/json-file-adapter";

export class PersistenceService {
  private state: HappyState;

  constructor(
    private readonly adapter: PersistentStateAdapter,
  ) {
    this.state = this.adapter.load();
  }

  create<T>(
    entityType: EntityType,
    id: string,
    data: T,
  ): PersistedRecord<T> {
    const key = ENTITY_STATE_KEYS[entityType];

    const collection = this.state[key] as PersistedRecord<T>[];

    if (collection.some((record) => record.id === id)) {
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

    collection.push(record);

    this.persist();

    return record;
  }

  get<T>(
    entityType: EntityType,
    id: string,
  ): PersistedRecord<T> | undefined {
    const key = ENTITY_STATE_KEYS[entityType];

    const collection = this.state[key] as PersistedRecord<T>[];

    return collection.find((record) => record.id === id);
  }

  list<T>(
    entityType: EntityType,
  ): PersistedRecord<T>[] {
    const key = ENTITY_STATE_KEYS[entityType];

    return [
      ...(this.state[key] as PersistedRecord<T>[]),
    ];
  }

  update<T>(
    entityType: EntityType,
    id: string,
    data: T,
  ): PersistedRecord<T> {
    const key = ENTITY_STATE_KEYS[entityType];

    const collection = this.state[key] as PersistedRecord<T>[];

    const index = collection.findIndex(
      (record) => record.id === id,
    );

    if (index === -1) {
      throw new Error(`Record not found: ${id}`);
    }

    const existing = collection[index];

    const updated: PersistedRecord<T> = {
      ...existing,
      version: existing.version + 1,
      updatedAt: new Date().toISOString(),
      data,
    };

    collection[index] = updated;

    this.persist();

    return updated;
  }

  delete(
    entityType: EntityType,
    id: string,
  ): boolean {
    const key = ENTITY_STATE_KEYS[entityType];

    const collection = this.state[key] as PersistedRecord<unknown>[];

    const index = collection.findIndex(
      (record) => record.id === id,
    );

    if (index === -1) {
      return false;
    }

    collection.splice(index, 1);

    this.persist();

    return true;
  }

  count(entityType?: EntityType): number {
    if (!entityType) {
      return Object.values(this.state)
        .reduce(
          (total, collection) =>
            total + collection.length,
          0,
        );
    }

    const key = ENTITY_STATE_KEYS[entityType];

    return this.state[key].length;
  }

  snapshot(): HappyState {
    return structuredClone(this.state);
  }

  reset(): void {
    this.state = createEmptyState();
    this.persist();
  }

  private persist(): void {
    this.adapter.save(this.state);
  }
}
