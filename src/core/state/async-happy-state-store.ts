import type { AsyncTenantPersistenceAdapter } from "../persistence/async-tenant-repository";
import { AsyncTenantScopedRepository } from "../persistence/async-tenant-repository";
import type { EntityType } from "../persistence/types";
import type { TenantScope } from "./types";

/**
 * Async entity-oriented state facade for durable, tenant-scoped adapters.
 * Unlike HappyStateStore, it never wraps the synchronous whole-state file
 * persistence service. Production adapters must enforce scope in storage.
 */
export class AsyncHappyStateStore {
  constructor(
    private readonly adapter: AsyncTenantPersistenceAdapter,
    private readonly scope: TenantScope,
  ) {}

  repository<T>(entityType: EntityType): AsyncTenantScopedRepository<T> {
    return new AsyncTenantScopedRepository<T>(
      entityType,
      this.scope,
      this.adapter,
    );
  }

  user<T = unknown>() { return this.repository<T>("USER"); }
  workspace<T = unknown>() { return this.repository<T>("WORKSPACE"); }
  project<T = unknown>() { return this.repository<T>("PROJECT"); }
  command<T = unknown>() { return this.repository<T>("COMMAND"); }
  mission<T = unknown>() { return this.repository<T>("MISSION"); }
  task<T = unknown>() { return this.repository<T>("TASK"); }
  execution<T = unknown>() { return this.repository<T>("EXECUTION"); }
  verification<T = unknown>() { return this.repository<T>("VERIFICATION"); }
  evidence<T = unknown>() { return this.repository<T>("EVIDENCE"); }
  memory<T = unknown>() { return this.repository<T>("MEMORY"); }
  approval<T = unknown>() { return this.repository<T>("APPROVAL"); }
  audit<T = unknown>() { return this.repository<T>("AUDIT_EVENT"); }
}
