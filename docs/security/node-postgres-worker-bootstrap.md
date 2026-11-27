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

### Concrete Node workload-identity composition

The Node bootstrap now exports `createNodeTrustedWorkerIdentityResolver()`. It composes the existing fail-closed `TrustedWorkerIdentityProvider` from three host-owned inputs:

- `TrustedWorkerCredentialSource`: reads a platform workload credential from a trusted runtime channel.
- `WorkerCredentialVerifier`: verifies the credential cryptographically. The repository's `JwksOidcWorkerCredentialVerifier` implements strict RS256/JWKS verification, issuer/audience pinning, exact subject and signed workload-claim checks, and bounded key refresh.
- `TrustedWorkerIdentityPolicy`: independently allowlists issuer, audience, environment, exact subjects, capabilities, and maximum credential lifetime.

Example shape (all values and adapters must come from the actual host's trusted deployment configuration):

```ts
import {
  createNodeTrustedWorkerIdentityResolver,
  createNodePostgresHappyWorker,
} from "./src/core/mission/node-postgres-happy-worker";
import { JwksOidcWorkerCredentialVerifier } from "./src/core/mission/jwks-oidc-worker-credential-verifier";

const identityProvider = createNodeTrustedWorkerIdentityResolver({
  credentialSource: platformWorkloadCredentialSource,
  credentialVerifier: new JwksOidcWorkerCredentialVerifier({
    issuer: trustedIssuer,
    audience: trustedAudience,
    jwksUri: trustedJwksUri,
    environment: "staging",
    expectedSubject: trustedExactSubject,
    expectedWorkloadClaims: {
      ownerId: trustedOwnerId,
      projectId: trustedProjectId,
      environment: "staging",
    },
    maxTokenLifetimeSeconds: 300,
    capabilities: ["CONTROL", "VERIFY"],
  }),
  policy: {
    issuer: trustedIssuer,
    audience: trustedAudience,
    environment: "staging",
    allowedSubjects: [trustedExactSubject],
    allowedCapabilities: ["CONTROL", "VERIFY"],
    maxCredentialLifetimeSeconds: 300,
  },
});

const worker = createNodePostgresHappyWorker({
  runtime: {
    identityProvider,
    pool, // host-created node-postgres Pool using the dedicated LOGIN
    expectedLoginRole: "happy_worker_staging",
  },
  tenantPersistence,
  provider: idempotentProvider,
});
```

The example deliberately leaves the credential source, issuer/JWKS metadata, subject, owner/project identifiers, pool, tenant persistence, and provider as host-supplied values. Do not substitute a request header, body field, query parameter, or user session. The verifier's signed workload claims and the identity provider's independent policy must agree; capabilities are deployment-owned, not caller-selected. The source-level regression test exercises this composition with a fake verifier and fixed clock only; it does not provision or attest a real workload identity.

## Bounded scheduler and graceful stop boundary

`runNodeWorkerBatch()` is the host-independent batch runner. It is deliberately sequential (concurrency 1), validates a maximum of 20 tenant grants per invocation, re-resolves workload identity and the principal registry before each grant scan, validates the returned organization/workspace/user tuple against the worker principal ID, and stops between operations when its AbortSignal is set. It supports one bounded mode per invocation: `READY_TASK` or `PENDING_DISPATCH`.

The required `AuthorizedWorkerTenantScopeSource` is an adapter contract, not a built-in grant implementation. A production host must implement it over the authoritative tenant-scope grant RPC, bound pagination, and return only grants active for the supplied verified identity and registry registration. No request-provided tenant IDs or arbitrary cross-tenant scans are accepted by the batch runner. The worker broker still re-verifies identity and registration immediately before each database operation.

The host owns process signal wiring: on SIGTERM/SIGINT it should abort the batch signal, await the in-flight bounded database/provider operation to settle, close the PostgreSQL pool, and exit. The batch runner does not forcibly cancel a provider request after it has begun, because that could create an ambiguous external side effect. The host must enforce its own process deadline and persist/reconcile ambiguous outcomes through the existing durable protocol.

## PostgreSQL-backed tenant-grant source

`PostgresWorkerTenantGrantSource` implements the scheduler's grant-source contract using the same dedicated worker PostgreSQL session boundary. It calls only the fixed `private.happy_worker_list_tenant_grants` RPC, requests one row per keyset page, validates UUIDs and the cursor, and binds the returned organization/workspace/user tuple to the verified registry principal. The Node factory is `createNodePostgresWorkerTenantScopeSource(runtimeConfig)`.

The matching SQL is intentionally in `supabase/drafts/20261127_worker_tenant_grant_page_rpc_candidate.sql`, not in the migration chain. The SECURITY DEFINER function derives the principal from PostgreSQL `session_user`, checks the exact principal selector, lists only enabled CONTROL grants with active organization/workspace and active organization/workspace memberships, locks the relevant rows, and bounds each page to 1–20 rows. The draft transfers ownership to the existing NOLOGIN registry-owner role and withholds EXECUTE grants.

**Isolated PostgreSQL 17 integration:** `scripts/security/postgres-worker-principal-registry-integration.sh` applies this candidate only to the disposable CI database, grants EXECUTE only to its test-only `happy_worker_dispatch` LOGIN, and verifies real `session_user` identity, worker-only EXECUTE ACL, first/next/empty keyset pages, bounded page size, partial-cursor rejection, principal-selector mismatch rejection, and immediate exclusion after workspace-membership revocation. The harness uses the same narrow SELECT/UPDATE column privileges as the owner-privilege candidate.

**Not yet deployable to Supabase:** an operator must review the draft, verify the hosted dedicated LOGIN using the read-only principal diagnostic, and explicitly grant EXECUTE only to that exact verified LOGIN. The isolated CI grant is disposable and is not in the SQL draft. No hosted tenant grant is created or changed by this code. Each claim/dispatch operation still rechecks the grant and memberships transactionally through the worker RPCs.

## Node process signal supervision

`runNodeWorkerProcess()` wraps exactly one bounded batch. It registers SIGINT/SIGTERM handlers, aborts the batch on the first shutdown signal, waits for the batch promise to settle, removes both listeners, and only then closes the host-owned PostgreSQL pool. It deliberately does not call `process.exit()` or retry provider side effects. The Node host should wire its actual `process` EventEmitter and `Pool.end()` into this adapter, then apply its own hard shutdown deadline and supervisor restart policy.

This is a supervised one-shot worker entrypoint, not a continuous daemon or scheduler service. Continuous scheduling, worker instance provisioning, provider configuration, and host deployment remain external integration work.

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
- The tenant-grant source and bounded scheduler are implemented at source level. No continuous cross-tenant polling daemon or deployed host scheduler is wired; the Node host must schedule bounded batches after the reviewed tenant-grant RPC is deployed.
- No continuous daemon loop, process supervisor, graceful-shutdown controller, or concurrency controller is supplied. The host should schedule bounded one-shot work and enforce its own shutdown/concurrency policy.
- Hosted pooler identity verification, staging RPC deployment, live database integration tests, and any production deployment remain separate approval-gated steps.

## Verification

Run the source-level bootstrap regression test:

```bash
npx --yes tsx@4.23.15 src/core/mission/node-postgres-happy-worker.test.ts
```

A passing construction test proves dependency composition and fail-closed configuration validation only. The isolated PostgreSQL 17 CI harness additionally exercises the tenant-grant SQL candidate against real PostgreSQL roles and RLS; it does not prove Supabase pooler identity behavior or a hosted worker dispatch.

## Composed Node host entrypoint

`runNodePostgresWorkerHost()` in
`src/core/mission/node-postgres-worker-host.ts` now wires the runtime dependencies,
authoritative PostgreSQL tenant-grant source, durable HAPPY worker, bounded
scheduler, SIGINT/SIGTERM supervisor, and pool shutdown into one host call.
The host still supplies its real pool, verified workload identity resolver,
tenant persistence, provider adapters, and process signal emitter.

The host entrypoint intentionally performs one bounded batch and closes the
pool. It does not start an unbounded daemon, create credentials, provision
roles, deploy the tenant-grant RPC, or grant EXECUTE. The regression test uses
a NOT_CONNECTED identity and asserts that no PostgreSQL connection is opened,
the worker fails closed, listeners are removed, and the pool lifecycle closes.

The composed host entrypoint requires the lifecycle adapter to be the exact same
pool instance injected into the runtime. Shutdown therefore cannot accidentally
close a different pool while leaving the broker's PostgreSQL connections open.
