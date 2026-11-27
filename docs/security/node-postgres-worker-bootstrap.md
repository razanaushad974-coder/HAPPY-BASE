# Host-independent Node.js PostgreSQL worker bootstrap

**Status: source-level composition added; live worker execution remains blocked pending trusted host adapters and hosted database evidence.**

## What this provides

- `createNodePostgresWorkerRuntimeDependencies()` composes the trusted workload identity resolver, dedicated PostgreSQL session provider, worker principal registry, and fixed-RPC database broker.
- `createNodePostgresHappyWorker()` exposes the existing durable HAPPY worker operations without importing Vercel OIDC or requiring a Vercel deployment.
- `createNodePostgresHappyWorkerFromEnvironment()` maps only the semantic verifier public-key allowlist and endpoint from a server-only environment object. The bearer token remains a callback to a secret manager.
- The Vercel worker now delegates to the same shared `createPostgresHappyWorker()` composition, avoiding a second orchestration implementation.

## Host contract

A Node.js host must inject:

1. A cryptographically verified `TrustedWorkerIdentityResolver`. It must obtain workload identity from the host's trusted identity channel, not request bodies, query strings, or user Authorization headers.
2. A real `node-postgres` `Pool` connected directly as the dedicated `happy_worker_*` LOGIN role. The host owns the `pg` package and pool construction; the web application does not gain a new database dependency from this change.
3. The canonical `AsyncTenantPersistenceAdapter` and an idempotent provider adapter.
4. Tenant scopes resolved from trusted server-side authorization, never supplied as arbitrary caller-controlled scope.
5. Secret-manager callbacks for any verifier bearer token. Public verifier keys may be supplied through server-only deployment configuration.

Example composition (the host supplies its actual identity, tenant, and provider adapters):

```ts
import { Pool } from "pg";
import {
  createNodePostgresHappyWorkerFromEnvironment,
} from "./src/core/mission/node-postgres-happy-worker";

const pool = new Pool({
  connectionString: process.env.HAPPY_WORKER_DATABASE_URL,
  max: 4,
  connectionTimeoutMillis: 5_000,
  idleTimeoutMillis: 30_000,
});

const worker = createNodePostgresHappyWorkerFromEnvironment({
  runtime: {
    identityProvider: trustedHostIdentityResolver,
    pool,
    expectedLoginRole: "happy_worker_staging",
    statementTimeoutMs: 15_000,
    idleTransactionTimeoutMs: 30_000,
  },
  tenantPersistence: canonicalTenantPersistence,
  provider: idempotentProviderAdapter,
  environment: process.env,
  readSemanticVerifierBearerToken: () => secretManager.read("HAPPY_SEMANTIC_VERIFIER_TOKEN"),
});

// Invoke only for a tenant scope obtained from the trusted worker grant resolver.
await worker.runOnePendingDispatch(authorizedWorkerTenantScope);
await pool.end();
```

The names `trustedHostIdentityResolver`, `canonicalTenantPersistence`, `idempotentProviderAdapter`, and `authorizedWorkerTenantScope` are host-owned adapters, not exported HAPPY globals or preconfigured credentials. The sample is an integration shape, not a runnable deployment by itself.

## Security invariants

- The session provider checks PostgreSQL `session_user` and `current_user` on every broker transaction; a mismatched role fails closed.
- The configured role must match `happy_worker_[a-z0-9_]{1,48}`; generic `service_role` and human sessions are rejected.
- Identity and principal-registry authorization are re-resolved before each broker operation by the authorized broker facade.
- The pool is not opened during composition. No live database readiness is inferred from constructing the worker.
- The module does not provision roles, apply migrations, grant RPC privileges, or perform hosted database changes.
- Provider dispatch remains idempotency-key gated and uses the existing lease heartbeat, fencing token, and durable outcome logic.

## Explicitly not completed by this bootstrap

- No concrete host identity provider or cryptographic workload credential source has been provisioned.
- No `pg` package or database URL has been added to the web application's dependencies.
- No trusted tenant-grant scanner / cross-tenant polling scheduler is wired. The host must resolve an authorized tenant scope and invoke one bounded operation; the current worker API does not authorize arbitrary tenant enumeration.
- No continuous daemon loop, process supervisor, graceful-shutdown controller, or concurrency controller is supplied. The host should schedule bounded one-shot work and enforce its own shutdown/concurrency policy.
- Hosted pooler identity verification, staging RPC deployment, live database integration tests, and any production deployment remain separate approval-gated steps.

## Verification

Run the source-level bootstrap regression test:

```bash
npx --yes tsx@4.23.15 src/core/mission/node-postgres-happy-worker.test.ts
```

A passing construction test proves dependency composition and fail-closed configuration validation only. It does not prove a real PostgreSQL connection or a hosted worker dispatch.
