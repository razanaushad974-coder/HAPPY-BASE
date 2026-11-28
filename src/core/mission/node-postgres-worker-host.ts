import type { AsyncTenantPersistenceAdapter } from "../persistence/async-tenant-repository";
import type {
  NodeWorkerSignalEmitter,
  NodeWorkerPoolLifecycle,
  NodeWorkerProcessResult,
  NodeWorkerDaemonResult,
} from "./node-worker-process";
import { runNodeWorkerDaemon, runNodeWorkerProcess } from "./node-worker-process";
import { runNodeWorkerBatch, type NodeWorkerOperation } from "./node-worker-scheduler";
import {
  createNodePostgresHappyWorker,
  createNodePostgresWorkerRuntimeDependencies,
  createNodePostgresWorkerTenantScopeSource,
  type NodePostgresWorkerRuntimeConfig,
} from "./node-postgres-happy-worker";
import type { IdempotentDispatchProvider } from "./durable-dispatch-worker-contract";
import type { ProviderStatusReader } from "./provider-dispatch-reconciliation";

/**
 * Composes one complete, bounded Node PostgreSQL worker invocation.
 *
 * The host still owns the actual pg Pool, trusted workload identity source,
 * tenant persistence, provider adapters, process signals, and restart policy.
 * This function only wires the already-verified HAPPY worker boundaries
 * together; it never provisions credentials, roles, grants, or database state.
 */
export async function runNodePostgresWorkerHost(input: {
  readonly runtime: Omit<NodePostgresWorkerRuntimeConfig, "pool"> & {
    readonly pool: NodePostgresWorkerRuntimeConfig["pool"] & NodeWorkerPoolLifecycle;
  };
  readonly signals: NodeWorkerSignalEmitter;
  readonly tenantPersistence: AsyncTenantPersistenceAdapter;
  readonly provider: IdempotentDispatchProvider;
  readonly reconciliationProvider?: ProviderStatusReader;
  readonly operation: NodeWorkerOperation;
  readonly maxTenants: number;
  readonly leaseMilliseconds?: number;
}): Promise<NodeWorkerProcessResult> {
  if (!input || !input.runtime || !input.runtime.pool || typeof input.runtime.pool.end !== "function" || !input.signals) {
    throw new TypeError("Node PostgreSQL worker host requires runtime, pool lifecycle, and process signals.");
  }

  const dependencies = createNodePostgresWorkerRuntimeDependencies(input.runtime);
  const tenantScopeSource = createNodePostgresWorkerTenantScopeSource(input.runtime);
  const worker = createNodePostgresHappyWorker({
    runtime: input.runtime,
    tenantPersistence: input.tenantPersistence,
    provider: input.provider,
    ...(input.reconciliationProvider ? { reconciliationProvider: input.reconciliationProvider } : {}),
    ...(input.leaseMilliseconds !== undefined ? { leaseMilliseconds: input.leaseMilliseconds } : {}),
  });

  return runNodeWorkerProcess({
    signals: input.signals,
    // The exact pool used by the broker is also the pool closed at shutdown.
    pool: input.runtime.pool,
    runBatch: (signal) => runNodeWorkerBatch({
      dependencies,
      tenantScopeSource,
      worker,
      operation: input.operation,
      maxTenants: input.maxTenants,
      signal,
    }),
  });
}


/**
 * Runs a bounded multi-batch Node worker session over one shared PostgreSQL
 * pool. The host supervisor can restart another bounded session after
 * maxBatches; SIGINT/SIGTERM stops polling, waits for the active batch, removes
 * listeners, and closes the exact pool used by the broker.
 */
export async function runNodePostgresWorkerDaemonHost(input: {
  readonly runtime: Omit<NodePostgresWorkerRuntimeConfig, "pool"> & {
    readonly pool: NodePostgresWorkerRuntimeConfig["pool"] & NodeWorkerPoolLifecycle;
  };
  readonly signals: NodeWorkerSignalEmitter;
  readonly tenantPersistence: AsyncTenantPersistenceAdapter;
  readonly provider: IdempotentDispatchProvider;
  readonly reconciliationProvider?: ProviderStatusReader;
  readonly operation: NodeWorkerOperation;
  readonly maxTenants: number;
  readonly maxBatches: number;
  readonly pollIntervalMs: number;
  readonly leaseMilliseconds?: number;
}): Promise<NodeWorkerDaemonResult> {
  if (!input || !input.runtime || !input.runtime.pool ||
      typeof input.runtime.pool.end !== "function" || !input.signals) {
    throw new TypeError("Node PostgreSQL worker daemon requires runtime, pool lifecycle, and process signals.");
  }

  const dependencies = createNodePostgresWorkerRuntimeDependencies(input.runtime);
  const tenantScopeSource = createNodePostgresWorkerTenantScopeSource(input.runtime);
  const worker = createNodePostgresHappyWorker({
    runtime: input.runtime,
    tenantPersistence: input.tenantPersistence,
    provider: input.provider,
    ...(input.reconciliationProvider ? { reconciliationProvider: input.reconciliationProvider } : {}),
    ...(input.leaseMilliseconds !== undefined ? { leaseMilliseconds: input.leaseMilliseconds } : {}),
  });

  return runNodeWorkerDaemon({
    signals: input.signals,
    pool: input.runtime.pool,
    maxBatches: input.maxBatches,
    pollIntervalMs: input.pollIntervalMs,
    runBatch: (signal) => runNodeWorkerBatch({
      dependencies,
      tenantScopeSource,
      worker,
      operation: input.operation,
      maxTenants: input.maxTenants,
      signal,
    }),
  });
}
