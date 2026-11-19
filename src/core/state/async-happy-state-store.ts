import { TenantBoundTransactionAdapter, requireCompleteScope, type AsyncTenantPersistenceAdapter } from "../persistence/async-tenant-repository";
import { AsyncTenantScopedRepository } from "../persistence/async-tenant-repository";
import type { EntityType } from "../persistence/types";
import type { TenantScope } from "./types";

/**
 * Async entity-oriented state facade for durable, tenant-scoped adapters.
 * Unlike HappyStateStore, it never wraps the synchronous whole-state file
 * persistence service. Production adapters must enforce scope in storage.
 */
export class AsyncHappyStateStore {
  private readonly scope: TenantScope & { userId: string };

  constructor(
    private readonly adapter: AsyncTenantPersistenceAdapter,
    scope: TenantScope,
  ) {
    requireCompleteScope(scope);
    this.scope = { ...scope, userId: scope.userId };
  }

  async transaction<T>(
    operation: (transactionStore: AsyncHappyStateStore) => Promise<T>,
  ): Promise<T> {
    return this.adapter.transaction(this.scope, async (transactionAdapter) =>
      operation(new AsyncHappyStateStore(
        new TenantBoundTransactionAdapter(this.scope, transactionAdapter),
        this.scope,
      )),
    );
  }

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
  verificationRequest<T = unknown>() { return this.repository<T>("VERIFICATION_REQUEST"); }
  evidence<T = unknown>() { return this.repository<T>("EVIDENCE"); }
  memory<T = unknown>() { return this.repository<T>("MEMORY"); }
  approval<T = unknown>() { return this.repository<T>("APPROVAL"); }
  audit<T = unknown>() { return this.repository<T>("AUDIT_EVENT"); }
}
