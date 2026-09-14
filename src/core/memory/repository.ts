import type {
  CreateMemoryInput,
  HappyMemory,
  MemoryQuery,
} from "./types";

function now(): string {
  return new Date().toISOString();
}

function createId(): string {
  return `mem_${crypto.randomUUID()}`;
}

/**
 * In-memory repository.
 *
 * This is intentionally an abstraction.
 * Database persistence will be connected later.
 */
export class MemoryRepository {
  private readonly memories = new Map<string, HappyMemory>();

  create(input: CreateMemoryInput): HappyMemory {
    if (!input.key.trim()) {
      throw new Error("Memory key cannot be empty.");
    }

    if (!input.value.trim()) {
      throw new Error("Memory value cannot be empty.");
    }

    if (!input.source.trim()) {
      throw new Error("Memory source cannot be empty.");
    }

    const timestamp = now();

    const memory: HappyMemory = {
      id: createId(),

      type: input.type,
      scope: input.scope,

      userId: input.userId,
      workspaceId: input.workspaceId,
      projectId: input.projectId,
      missionId: input.missionId,
      taskId: input.taskId,

      key: input.key.trim(),
      value: input.value.trim(),

      confidence: input.confidence ?? "MEDIUM",

      source: input.source.trim(),

      createdAt: timestamp,
      updatedAt: timestamp,

      expiresAt: input.expiresAt,
    };

    this.memories.set(memory.id, memory);

    return memory;
  }

  get(id: string): HappyMemory | undefined {
    return this.memories.get(id);
  }

  update(id: string, patch: Partial<Pick<
    HappyMemory,
    "value" | "confidence" | "expiresAt"
  >>): HappyMemory {
    const existing = this.memories.get(id);

    if (!existing) {
      throw new Error(`Memory not found: ${id}`);
    }

    const updated: HappyMemory = {
      ...existing,
      ...patch,
      updatedAt: now(),
    };

    this.memories.set(id, updated);

    return updated;
  }

  delete(id: string): boolean {
    return this.memories.delete(id);
  }

  search(query: MemoryQuery = {}): HappyMemory[] {
    const text = query.text?.trim().toLowerCase();

    const results = Array.from(this.memories.values()).filter((memory) => {
      if (query.userId && memory.userId !== query.userId) {
        return false;
      }

      if (query.workspaceId && memory.workspaceId !== query.workspaceId) {
        return false;
      }

      if (query.projectId && memory.projectId !== query.projectId) {
        return false;
      }

      if (query.missionId && memory.missionId !== query.missionId) {
        return false;
      }

      if (query.taskId && memory.taskId !== query.taskId) {
        return false;
      }

      if (query.type && memory.type !== query.type) {
        return false;
      }

      if (query.scope && memory.scope !== query.scope) {
        return false;
      }

      if (
        query.key &&
        memory.key.toLowerCase() !== query.key.toLowerCase()
      ) {
        return false;
      }

      if (
        text &&
        !memory.key.toLowerCase().includes(text) &&
        !memory.value.toLowerCase().includes(text)
      ) {
        return false;
      }

      return true;
    });

    results.sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() -
        new Date(a.updatedAt).getTime(),
    );

    const limit = query.limit ?? 50;

    return results.slice(0, Math.max(0, limit));
  }

  count(): number {
    return this.memories.size;
  }
}
