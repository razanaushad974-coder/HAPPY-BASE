# Supabase staging migration readiness — 2026-11-23

## Scope and environment

- Target: dedicated Supabase staging project `happy-worker-staging`.
- Project ref: `kcbbfwtvkjepvtbmbrse`.
- Region: `ap-northeast-1`.
- PostgreSQL: `17.12`.
- Project status: `ACTIVE_HEALTHY`.
- Existing migration history: empty.
- The staging project has only the platform schemas `auth`, `extensions`, `public`, and `vault`; the application-owned `private` schema is absent.
- Live SQL inspection observed `session_user = current_user = postgres`. This does not verify a dedicated worker login or pooler identity preservation.
- No migration, role, grant, or application table was created by this review.

## Repository inventory at reviewed branch

The Supabase directory contains only `supabase/drafts/`; there is no checked-in `supabase/migrations/` directory on the reviewed branch. The available candidates are:

1. `20261119_file_mutation_atomic_consume_candidate.sql` — canonical organization/workspace/membership identity tables, execution request and file-mutation approval structures.
2. `20261119_async_tenant_persistence_schema_candidate.sql` — tenant-scoped generic records and CAS functions; depends on the canonical identity tables above.
3. `20261121_authenticated_execution_request_rpc_candidate.sql` and `20261121_authenticated_execution_envelope_candidate.sql` — authenticated request creation/decision and immutable approval envelope; the envelope candidate explicitly depends on other candidates.
4. `20261121_durable_mission_scheduler_candidate.sql` — human-session durable lease/outbox base; its review identifies security and invariant gaps.
5. `20261122_worker_principal_registry_candidate.sql` — worker registry and tenant grants; depends on canonical identity tables and references a function-owner role that is not provisioned in the file.
6. `20261122_worker_scheduler_rpc_candidate.sql` — seven worker-specific scheduler/evidence RPCs; depends on the durable scheduler and worker registry candidates.
7. `20261123_worker_registry_helper_grant_candidate.sql` and `20261123_worker_scheduler_rpc_grant_candidate.sql` — separate capability-scoped grants; operator candidates, not migrations.

These are explicitly labelled design-only candidates. The worker registry candidate says it intentionally omits CREATE ROLE, credentials, and grants. The worker scheduler candidate withholds all EXECUTE grants.

## Blocking findings

### P0 — No deployable migration chain

The repository contains no migration directory or migration history. The SQL files are separate drafts with explicit cross-file dependencies. Applying them ad hoc would not provide a reproducible, ordered, rollback-aware deployment history. A migration chain must be assembled and reviewed before staging application.

### P0 — Function-owner model is incomplete

The registry draft creates RLS policies for `happy_worker_registry_owner` but does not create that role or establish its complete schema/table/function privileges. The scheduler functions are SECURITY DEFINER, but the candidate does not establish a reviewed, least-privilege owner model for every function. Do not leave privileged functions owned by the administrative `postgres` role as a shortcut.

Required design:
- Separate NOLOGIN, NOBYPASSRLS owner roles for registry/scope resolution and scheduler operations, with explicit non-inheriting membership and only the minimum schema, table, column, and function privileges.
- Every SECURITY DEFINER function must have a fixed safe search_path, an explicit owner, and tested grants.
- RLS policies and privileges must permit only the required row locks and writes; policies alone do not grant SQL privileges.
- No owner role may have BYPASSRLS, SUPERUSER, CREATEROLE, CREATEDB, REPLICATION, or LOGIN.

### P0 — Worker database identity is not connected

The only live identity check returned `session_user = current_user = postgres`. No dedicated `happy_worker_*` LOGIN, credential rotation path, pooler identity preservation test, registry row, or live worker principal verification has been performed. Do not create a worker registry row until an actual runtime identity (issuer, subject, audience, environment) is verified.

### P0 — Worker dispatch authority must remain gated

The durable scheduler review records previous P0 issues around persisted execution-request and founder-approval binding, graph/retry invariants, outbox immutability, and idempotent handling of ambiguous provider outcomes. The worker-specific RPCs are designed to resolve identity from `session_user`, but they remain inert until those request/approval invariants and owner privileges are verified against the exact SQL.

### P1 — Hosted Supabase compatibility

A local PostgreSQL 17 harness is not proof that hosted Supabase preserves `session_user` through its supported connection/pooler path, or that the proposed role and RLS arrangement works in the hosted environment. These require disposable staging tests using the actual dedicated login and connection path.

## Required migration sequence

1. Reconcile the canonical tenant identity and file-mutation approval schema into a baseline migration; review ownership, auth references, RLS, and grants.
2. Add tenant record persistence and CAS RPCs; test cross-user/workspace denial, revoked membership, stale versions, concurrent writes, and rollback.
3. Add authenticated execution-request creation, immutable envelope, founder approval evidence, and decision RPCs; test fabricated selectors, self-approval, revoked membership, stale decisions, and altered envelope fields.
4. Add durable mission/task/lease/outbox/reconciliation schema only after the request and approval binding is complete; test malformed graphs, retry exhaustion, lease fencing, outbox immutability, and idempotency.
5. Add dedicated worker registry and tenant grant schema with separately provisioned NOLOGIN function-owner roles and exact owner privileges.
6. Add worker RPCs and narrowly scoped grants only after a dedicated DB login is provisioned and live `session_user` verification passes.
7. Add the Vercel worker runtime with a supported OIDC source, issuer/audience/subject/environment verification, expiry/replay/revocation checks, and the dedicated PostgreSQL pool.
8. Run end-to-end staging tests for tenant isolation, founder approval, claim/heartbeat/outcome, lease fencing, crash recovery, late provider responses, and ambiguous dispatch reconciliation.

## Explicit non-actions

- No SQL from `supabase/drafts/` was applied.
- No roles, passwords, worker credentials, registry rows, grants, or RPC EXECUTE permissions were created.
- No production project, production deployment, or main project was modified.
- No claim is made that live worker dispatch is connected.

## Acceptance gate

Only promote a reviewed migration when it has: an ordered dependency chain; explicit function owners and grants; static SQL contract checks; disposable PostgreSQL adversarial tests; hosted staging verification using the actual login/pooler; and a reviewed rollback/recovery procedure. Keep all worker RPCs unavailable until the worker identity and approval binding tests pass.
