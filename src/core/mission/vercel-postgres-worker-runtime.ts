import type { PgPoolLike } from "../persistence/adapters/postgres-tenant-adapter";
import {
  JwksOidcWorkerCredentialVerifier,
  type JwksOidcVerifierConfig,
  type WorkerJwksFetcher,
} from "./jwks-oidc-worker-credential-verifier";
import {
  PostgresWorkerDatabaseBroker,
} from "./postgres-worker-database-broker";
import { PostgresWorkerDatabaseSessionProvider } from "./postgres-worker-database-session";
import { PostgresWorkerPrincipalRegistry } from "./postgres-worker-principal-registry";
import {
  TrustedWorkerIdentityProvider,
  type TrustedWorkerIdentityPolicy,
  type WorkerCapability,
} from "./trusted-worker-identity";
import {
  VercelOidcWorkerCredentialSource,
  type VercelOidcTokenReader,
} from "./vercel-oidc-worker-credential-source";
import type { WorkerRuntimeCompositionDependencies } from "./worker-runtime-composition";

export interface VercelPostgresWorkerRuntimeConfig {
  readonly tokenReader: VercelOidcTokenReader;
  /** Must be the platform's official getVercelOidcToken helper, invoked fresh per resolution. */
  readonly jwks: Omit<JwksOidcVerifierConfig, "now"> & { readonly now?: () => number };
  readonly database: {
    /** A real node-postgres Pool connected as the dedicated happy_worker_* LOGIN role. */
    readonly pool: PgPoolLike;
    readonly expectedLoginRole: string;
    readonly statementTimeoutMs?: number;
    readonly idleTransactionTimeoutMs?: number;
  };
}

/**
 * Concrete composition seam for a dedicated Vercel worker deployment.
 *
 * The caller must pass getVercelOidcToken from @vercel/oidc and a real pg.Pool.
 * This module intentionally does not import either package so the core can be
 * tested without provisioning platform credentials or opening network sockets.
 * Never pass a Supabase service-role client or a human-authenticated pool.
 */
export function createVercelPostgresWorkerRuntimeDependencies(
  config: VercelPostgresWorkerRuntimeConfig,
  fetcher?: WorkerJwksFetcher,
): WorkerRuntimeCompositionDependencies {
  const capabilities = config?.jwks?.capabilities;
  if (
    !config ||
    typeof config.tokenReader !== "function" ||
    !config.jwks ||
    !config.database?.pool ||
    !Array.isArray(capabilities) ||
    capabilities.length === 0 ||
    new Set(capabilities).size !== capabilities.length ||
    !capabilities.includes("CONTROL") ||
    !capabilities.includes("VERIFY")
  ) {
    throw new TypeError("Vercel worker runtime requires a fresh OIDC token reader, real PostgreSQL pool, and CONTROL+VERIFY grants.");
  }

  const source = new VercelOidcWorkerCredentialSource(config.tokenReader);
  const verifierConfig: JwksOidcVerifierConfig = {
    ...config.jwks,
    capabilities: [...capabilities],
  };
  const verifier = new JwksOidcWorkerCredentialVerifier(
    verifierConfig,
    fetcher,
  );
  const policy: TrustedWorkerIdentityPolicy = {
    issuer: config.jwks.issuer,
    audience: config.jwks.audience,
    environment: config.jwks.environment,
    allowedSubjects: [config.jwks.expectedSubject],
    allowedCapabilities: [...capabilities] as WorkerCapability[],
    maxCredentialLifetimeSeconds: config.jwks.maxTokenLifetimeSeconds,
  };

  const identityProvider = new TrustedWorkerIdentityProvider(
    source,
    verifier,
    policy,
    config.jwks.now,
  );
  const sessions = new PostgresWorkerDatabaseSessionProvider(
    config.database.pool,
    {
      expectedLoginRole: config.database.expectedLoginRole,
      ...(config.database.statementTimeoutMs !== undefined
        ? { statementTimeoutMs: config.database.statementTimeoutMs }
        : {}),
      ...(config.database.idleTransactionTimeoutMs !== undefined
        ? { idleTransactionTimeoutMs: config.database.idleTransactionTimeoutMs }
        : {}),
    },
  );

  return Object.freeze({
    identityProvider,
    principalRegistry: new PostgresWorkerPrincipalRegistry(sessions),
    databaseBroker: new PostgresWorkerDatabaseBroker(sessions),
  });
}
