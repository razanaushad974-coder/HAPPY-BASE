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
import { createAsyncHappyStateStore } from "../state/async-factory";
import { AsyncEvidenceService } from "../evidence/async-service";
import { AsyncVerificationService } from "../verification/async-service";

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

  const createTenantVerificationServices = (scope: TenantScope & { readonly userId: string }) => {
    if (!scope.organizationId?.trim() || !scope.workspaceId?.trim() || !scope.userId?.trim()) {
      throw new TypeError("Complete organization, workspace, and user scope is required.");
    }
    const state = createAsyncHappyStateStore(
      input.tenantPersistence,
      scope.organizationId,
      scope.workspaceId,
      scope.userId,
    );
    return Object.freeze({
      evidence: new AsyncEvidenceService(state),
      verification: new AsyncVerificationService(
        state,
        semanticAuthority,
        externalSemanticVerifierClient,
      ),
    });
  };

  return Object.freeze({
    /**
     * Creates the tenant-bound verification and evidence services over the
     * worker's durable tenant adapter. Scope must come from the caller's
     * already-authenticated/authorized tenant resolution, never request IDs.
     */
    createTenantVerificationServices,


    /**
     * Runs one registered verification request through the configured external
     * verifier, using only the tenant-scoped evidence store and server-side
     * verifier transport. The caller must supply an authenticated tenant scope.
     */
    verifyTenantRequest(input: {
      readonly scope: TenantScope & { readonly userId: string };
      readonly requestId: string;
      readonly evidenceIds: string[];
    }) {
      const services = createTenantVerificationServices(input.scope);
      return services.verification.verifyWithExternalVerifier(
        input.requestId,
        input.evidenceIds,
      );
    },

    /**
     * Persists a task transition using the same trusted signing authority that
     * validates verifier results. Verification-gated completion requires the
     * exact persisted request/result/evidence chain in the same tenant.
     */
    transitionTaskDurable(transition: {
      readonly scope: TenantScope & { readonly userId: string };
      readonly missionId: string;
      readonly taskId: string;
      readonly status: import("./types").MissionTask["status"];
      readonly verificationRequestId?: string;
    }) {
      return orchestrator.transitionTaskDurable({
        ...transition,
        persistence: input.tenantPersistence,
      });
    },

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

    /**
     * Performs a read-only recovery assessment using the authenticated worker
     * broker for provider evidence. It never retries or mutates mission state.
     */
    assessTenantMissionRecovery(request: {
      readonly scope: TenantScope & { readonly userId: string };
      readonly workerScope: WorkerTenantScope;
      readonly missionId: string;
    }) {
      return orchestrator.assessWorkerMissionRecovery({
        scope: request.scope,
        tenantScope: request.workerScope,
        persistence: input.tenantPersistence,
        missionId: request.missionId,
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
