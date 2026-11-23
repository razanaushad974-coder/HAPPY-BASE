import { randomUUID } from "node:crypto";

import type { AsyncTenantPersistenceAdapter } from "../persistence/async-tenant-repository";
import type { TenantScope } from "../state/types";
import type { IdempotentDispatchProvider } from "./durable-dispatch-worker-contract";
import type { ProviderStatusReader } from "./provider-dispatch-reconciliation";
import type { WorkerTenantScope } from "./worker-database-broker";
import {
  createVercelPostgresWorkerRuntimeDependencies,
  type VercelPostgresWorkerRuntimeConfig,
} from "./vercel-postgres-worker-runtime";
import { MissionOrchestrator } from "./orchestrator";

/**
 * Server-only one-shot worker entrypoint for a dedicated Vercel deployment.
 *
 * The host supplies the official Vercel OIDC token reader, a real pg.Pool
 * authenticated as happy_worker_*, tenant persistence, and an idempotent
 * provider adapter. Each invocation receives a fresh server-generated owner
 * ID and performs at most one durable task/dispatch iteration. Scheduling,
 * concurrency limits, shutdown, and secret provisioning belong to the host.
 *
 * This factory does not provision a database role, deploy RPCs, or claim that
 * the supplied pool is live; the session provider verifies session_user and
 * current_user on every broker transaction.
 */
export function createVercelPostgresHappyWorker(input: {
  readonly runtime: VercelPostgresWorkerRuntimeConfig;
  readonly tenantPersistence: AsyncTenantPersistenceAdapter;
  readonly provider: IdempotentDispatchProvider;
  readonly reconciliationProvider?: ProviderStatusReader;
  readonly leaseMilliseconds?: number;
}) {
  const leaseMilliseconds = input.leaseMilliseconds ?? 60_000;
  if (!Number.isSafeInteger(leaseMilliseconds) ||
      leaseMilliseconds < 5_000 || leaseMilliseconds > 300_000) {
    throw new RangeError("Worker lease must be between 5,000 and 300,000 milliseconds.");
  }

  const dependencies = createVercelPostgresWorkerRuntimeDependencies(input.runtime);
  const orchestrator = new MissionOrchestrator(dependencies);

  return Object.freeze({
    /** Scans only this exact tenant and processes at most one ready task. */
    runOneReadyTask(tenant: { readonly scope: TenantScope; readonly workerScope: WorkerTenantScope }) {
      return orchestrator.runNextReadyMissionTaskDispatch({
        persistence: input.tenantPersistence,
        scope: tenant.scope,
        tenantScope: tenant.workerScope,
        ownerId: randomUUID(),
        leaseMilliseconds,
        provider: input.provider,
        ...(input.reconciliationProvider
          ? { reconciliationProvider: input.reconciliationProvider }
          : {}),
      });
    },

    /** Claims at most one already-enqueued outbox item for this tenant. */
    runOnePendingDispatch(workerScope: WorkerTenantScope) {
      return orchestrator.runNextWorkerDispatch({
        tenantScope: workerScope,
        ownerId: randomUUID(),
        leaseMilliseconds,
        provider: input.provider,
        ...(input.reconciliationProvider
          ? { reconciliationProvider: input.reconciliationProvider }
          : {}),
      });
    },
  });
}
