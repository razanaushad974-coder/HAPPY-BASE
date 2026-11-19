import { randomUUID } from "node:crypto";

import type { TenantScope } from "../state/types";
import {
  AsyncTenantScopedRepository,
  type AsyncTenantPersistenceAdapter,
} from "../persistence/async-tenant-repository";
import type { HappyMemory, CreateMemoryInput, MemoryQuery } from "./types";

/**
 * Tenant-scoped async memory service.
 *
 * This service is deliberately adapter-injected: it does not silently fall
 * back to JSON files or an in-memory provider. Production callers must supply
 * a durable adapter that enforces tenant predicates and atomic CAS writes.
 */
export class AsyncPersistentMemoryService {
  private readonly repository: AsyncTenantScopedRepository<HappyMemory>;

  constructor(
    scope: TenantScope,
    adapter: AsyncTenantPersistenceAdapter,
  ) {
    this.scopeUserId = scope.userId ?? "";
    this.scopeWorkspaceId = scope.workspaceId;
    this.repository = new AsyncTenantScopedRepository<HappyMemory>(
      "MEMORY",
      scope,
      adapter,
    );
  }

  async remember(input: CreateMemoryInput): Promise<HappyMemory> {
    if (!input.key.trim()) throw new Error("Memory key cannot be empty.");
    if (!input.value.trim()) throw new Error("Memory value cannot be empty.");
    if (!input.source.trim()) throw new Error("Memory source cannot be empty.");

    const now = new Date().toISOString();
    const memory: HappyMemory = {
      id: `mem_${randomUUID()}`,
      type: input.type,
      scope: input.scope,
      // Tenant identity is always derived from the authenticated repository
      // scope, never from caller-provided memory fields.
      userId: this.repositoryScopeUserId(),
      workspaceId: this.repositoryScopeWorkspaceId(),
      projectId: input.projectId,
      missionId: input.missionId,
      taskId: input.taskId,
      key: input.key.trim(),
      value: input.value.trim(),
      confidence: input.confidence ?? "MEDIUM",
      source: input.source.trim(),
      createdAt: now,
      updatedAt: now,
      expiresAt: input.expiresAt,
    };

    await this.repository.create(memory.id, memory);
    return memory;
  }

  async recall(id: string): Promise<HappyMemory | undefined> {
    return (await this.repository.get(id))?.data;
  }

  async search(query: MemoryQuery = {}): Promise<HappyMemory[]> {
    // User/workspace filters can only narrow the already scoped result set.
    if (
      (query.userId && query.userId !== this.repositoryScopeUserId()) ||
      (query.workspaceId && query.workspaceId !== this.repositoryScopeWorkspaceId())
    ) return [];

    const rows = await this.repository.list();
    const text = query.text?.trim().toLowerCase();
    const results = rows
      .map((row) => row.data)
      .filter((memory) => {
        if (query.projectId && memory.projectId !== query.projectId) return false;
        if (query.missionId && memory.missionId !== query.missionId) return false;
        if (query.taskId && memory.taskId !== query.taskId) return false;
        if (query.type && memory.type !== query.type) return false;
        if (query.scope && memory.scope !== query.scope) return false;
        if (query.key && memory.key.toLowerCase() !== query.key.toLowerCase()) return false;
        if (text && !memory.key.toLowerCase().includes(text) && !memory.value.toLowerCase().includes(text)) return false;
        return true;
      });

    results.sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
    return results.slice(0, Math.max(0, query.limit ?? 50));
  }

  async update(
    id: string,
    patch: Partial<Pick<HappyMemory, "value" | "confidence" | "expiresAt">>,
  ): Promise<HappyMemory> {
    const existing = await this.repository.get(id);
    if (!existing) throw new Error(`Memory not found: ${id}`);

    const updated: HappyMemory = {
      ...existing.data,
      ...patch,
      updatedAt: new Date().toISOString(),
    };
    await this.repository.update(id, existing.version, updated);
    return updated;
  }

  async forget(id: string): Promise<boolean> {
    const existing = await this.repository.get(id);
    if (!existing) return false;
    return this.repository.delete(id, existing.version);
  }

  async count(): Promise<number> {
    return (await this.repository.list()).length;
  }

  // These are immutable values captured from the validated repository scope.
  // Kept private so callers cannot override tenant identity.
  private repositoryScopeUserId(): string {
    return this.scopeUserId;
  }

  private repositoryScopeWorkspaceId(): string {
    return this.scopeWorkspaceId;
  }

  private readonly scopeUserId: string;
  private readonly scopeWorkspaceId: string;
}
