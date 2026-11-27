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
import { createTrustedSemanticAttestationAuthority } from "../verification/semantic-attestation-config";
import { HttpExternalSemanticVerifierClient } from "../verification/external-verifier-client";

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
  /** Operator-provisioned JSON public-key allowlist; pass from server deployment config only. */
  readonly semanticVerifierKeysJson?: string;
  /** Fixed HTTPS endpoint from server-only deployment configuration. */
  readonly semanticVerifierEndpoint?: string;
  /** Reads the verifier bearer token from a server-side secret store. */
  readonly readSemanticVerifierBearerToken?: () => Promise<string>;
}) {
  const leaseMilliseconds = input.leaseMilliseconds ?? 60_000;
  if (!Number.isSafeInteger(leaseMilliseconds) ||
      leaseMilliseconds < 5_000 || leaseMilliseconds > 300_000) {
    throw new RangeError("Worker lease must be between 5,000 and 300,000 milliseconds.");
  }

  const dependencies = createVercelPostgresWorkerRuntimeDependencies(input.runtime);
  const semanticAuthority = createTrustedSemanticAttestationAuthority(input.semanticVerifierKeysJson);
  if (Boolean(input.semanticVerifierEndpoint) !== Boolean(input.readSemanticVerifierBearerToken)) {
    throw new TypeError("External semantic verifier endpoint and server-side bearer-token reader must be configured together.");
  }
  const externalSemanticVerifierClient = input.semanticVerifierEndpoint && input.readSemanticVerifierBearerToken
    ? new HttpExternalSemanticVerifierClient({
        endpoint: input.semanticVerifierEndpoint,
        readBearerToken: input.readSemanticVerifierBearerToken,
      })
    : null;
  const orchestrator = new MissionOrchestrator(dependencies, semanticAuthority);

  return Object.freeze({
    /** Server-configured verifier transport for tenant-scoped verification services. */
    semanticVerifier: Object.freeze({
      authority: semanticAuthority,
      client: externalSemanticVerifierClient,
      status: semanticAuthority && externalSemanticVerifierClient ? "CONFIGURED" as const : "NOT_CONFIGURED" as const,
    }),
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
