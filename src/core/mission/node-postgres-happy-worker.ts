import type { AsyncTenantPersistenceAdapter } from "../persistence/async-tenant-repository";
import type { PgPoolLike } from "../persistence/adapters/postgres-tenant-adapter";
import type { IdempotentDispatchProvider, TrustedWorkerIdentityResolver } from "./durable-dispatch-worker-contract";
import type { ProviderStatusReader } from "./provider-dispatch-reconciliation";
import { PostgresWorkerDatabaseBroker } from "./postgres-worker-database-broker";
import { PostgresWorkerDatabaseSessionProvider } from "./postgres-worker-database-session";
import { PostgresWorkerPrincipalRegistry } from "./postgres-worker-principal-registry";
import { PostgresWorkerTenantGrantSource } from "./postgres-worker-tenant-grant-source";
import { createPostgresHappyWorker } from "./vercel-postgres-happy-worker";
import type { WorkerRuntimeCompositionDependencies } from "./worker-runtime-composition";

/**
 * Host-independent Node.js worker composition.
 *
 * The host injects a platform-attested identity resolver and a real node-postgres
 * Pool. This module has no Vercel imports and never reads identity from an HTTP
 * request. The pool must authenticate directly as the dedicated happy_worker_*
 * LOGIN; every broker transaction verifies session_user and current_user.
 */
export interface NodePostgresWorkerRuntimeConfig {
  readonly identityProvider: TrustedWorkerIdentityResolver;
  readonly pool: PgPoolLike;
  readonly expectedLoginRole: string;
  readonly statementTimeoutMs?: number;
  readonly idleTransactionTimeoutMs?: number;
}

export function createNodePostgresWorkerRuntimeDependencies(
  config: NodePostgresWorkerRuntimeConfig,
): WorkerRuntimeCompositionDependencies {
  if (!config || typeof config !== "object" ||
      !config.identityProvider ||
      typeof config.identityProvider.getVerifiedWorkerIdentity !== "function" ||
      !config.pool || typeof config.pool.connect !== "function") {
    throw new TypeError("Node PostgreSQL worker requires a trusted identity resolver and a real PostgreSQL pool.");
  }

  const sessions = new PostgresWorkerDatabaseSessionProvider(config.pool, {
    expectedLoginRole: config.expectedLoginRole,
    ...(config.statementTimeoutMs !== undefined
      ? { statementTimeoutMs: config.statementTimeoutMs }
      : {}),
    ...(config.idleTransactionTimeoutMs !== undefined
      ? { idleTransactionTimeoutMs: config.idleTransactionTimeoutMs }
      : {}),
  });

  return Object.freeze({
    identityProvider: config.identityProvider,
    principalRegistry: new PostgresWorkerPrincipalRegistry(sessions),
    databaseBroker: new PostgresWorkerDatabaseBroker(sessions),
  });
}

/**
 * Creates the authoritative PostgreSQL tenant-grant scanner for the same
 * dedicated worker LOGIN. Its SQL candidate remains ungranted until the
 * hosted identity and function-owner checks have been approved.
 */
export function createNodePostgresWorkerTenantScopeSource(
  config: NodePostgresWorkerRuntimeConfig,
): PostgresWorkerTenantGrantSource {
  if (!config || !config.pool || typeof config.pool.connect !== "function") {
    throw new TypeError("Node PostgreSQL tenant grant source requires a real PostgreSQL pool.");
  }
  const sessions = new PostgresWorkerDatabaseSessionProvider(config.pool, {
    expectedLoginRole: config.expectedLoginRole,
    ...(config.statementTimeoutMs !== undefined
      ? { statementTimeoutMs: config.statementTimeoutMs }
      : {}),
    ...(config.idleTransactionTimeoutMs !== undefined
      ? { idleTransactionTimeoutMs: config.idleTransactionTimeoutMs }
      : {}),
  });
  return new PostgresWorkerTenantGrantSource(sessions);
}

/** Builds the same durable HAPPY worker API without requiring Vercel OIDC. */
export function createNodePostgresHappyWorker(input: {
  readonly runtime: NodePostgresWorkerRuntimeConfig;
  readonly tenantPersistence: AsyncTenantPersistenceAdapter;
  readonly provider: IdempotentDispatchProvider;
  readonly reconciliationProvider?: ProviderStatusReader;
  readonly leaseMilliseconds?: number;
  readonly semanticVerifierKeysJson?: string;
  readonly semanticVerifierEndpoint?: string;
  readonly readSemanticVerifierBearerToken?: () => Promise<string>;
}) {
  const dependencies = createNodePostgresWorkerRuntimeDependencies(input.runtime);
  return createPostgresHappyWorker({
    dependencies,
    tenantPersistence: input.tenantPersistence,
    provider: input.provider,
    ...(input.reconciliationProvider ? { reconciliationProvider: input.reconciliationProvider } : {}),
    ...(input.leaseMilliseconds !== undefined ? { leaseMilliseconds: input.leaseMilliseconds } : {}),
    ...(input.semanticVerifierKeysJson !== undefined
      ? { semanticVerifierKeysJson: input.semanticVerifierKeysJson }
      : {}),
    ...(input.semanticVerifierEndpoint !== undefined
      ? { semanticVerifierEndpoint: input.semanticVerifierEndpoint }
      : {}),
    ...(input.readSemanticVerifierBearerToken
      ? { readSemanticVerifierBearerToken: input.readSemanticVerifierBearerToken }
      : {}),
  });
}

/** Server-only environment adapter; pass process.env only from the Node host entrypoint. */
export function createNodePostgresHappyWorkerFromEnvironment(input: {
  readonly runtime: NodePostgresWorkerRuntimeConfig;
  readonly tenantPersistence: AsyncTenantPersistenceAdapter;
  readonly provider: IdempotentDispatchProvider;
  readonly reconciliationProvider?: ProviderStatusReader;
  readonly leaseMilliseconds?: number;
  readonly environment?: Readonly<Record<string, string | undefined>>;
  readonly readSemanticVerifierBearerToken?: () => Promise<string>;
}) {
  const environment = input.environment ?? process.env;
  return createNodePostgresHappyWorker({
    runtime: input.runtime,
    tenantPersistence: input.tenantPersistence,
    provider: input.provider,
    ...(input.reconciliationProvider ? { reconciliationProvider: input.reconciliationProvider } : {}),
    ...(input.leaseMilliseconds !== undefined ? { leaseMilliseconds: input.leaseMilliseconds } : {}),
    ...(environment.HAPPY_SEMANTIC_VERIFIER_KEYS
      ? { semanticVerifierKeysJson: environment.HAPPY_SEMANTIC_VERIFIER_KEYS }
      : {}),
    ...(environment.HAPPY_SEMANTIC_VERIFIER_ENDPOINT
      ? { semanticVerifierEndpoint: environment.HAPPY_SEMANTIC_VERIFIER_ENDPOINT }
      : {}),
    ...(input.readSemanticVerifierBearerToken
      ? { readSemanticVerifierBearerToken: input.readSemanticVerifierBearerToken }
      : {}),
  });
}
