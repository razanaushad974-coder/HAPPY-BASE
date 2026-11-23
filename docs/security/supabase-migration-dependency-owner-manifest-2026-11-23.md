# HAPPY Supabase staging migration dependency and ownership manifest

**Status:** design/preflight artifact only. Nothing in this manifest authorizes a database apply.
**Reviewed branch:** `security/staging-migration-readiness`
**Target:** isolated `happy-worker-staging` project only, after explicit approval.

## Repository bootstrap gate

- [ ] Add `supabase/config.toml` through the Supabase CLI-supported initialization workflow.
- [ ] Create ordered migration files using `supabase migration new <name>`; do not rename drafts into migrations manually.
- [ ] Confirm the migration chain is reproducible from an empty staging database.
- [ ] Record migration checksums, apply order, verification queries, and recovery/forward-fix procedure.
- [ ] Keep the main Supabase project and production deployments out of scope.

The branch currently contains only `supabase/drafts/`; it has no checked-in `supabase/config.toml` or `supabase/migrations/`.

## Dependency graph

| Stage | Source draft(s) | Required predecessor | Intended owner / authority | Status / gate |
|---|---|---|---|---|
| 0. Canonical identity baseline | `20261119_file_mutation_atomic_consume_candidate.sql` | Supabase Auth baseline | Administrative migration executor for table bootstrap; runtime access must be separately reviewed | **BLOCKED**: contains legacy broad `service_role` private-table grants and file-mutation endpoint surface; split/rework before migration |
| 1. Tenant persistence | `20261119_async_tenant_persistence_schema_candidate.sql` | Stage 0 identity tables | `happy_tenant_scope_rpc_owner` | **BLOCKED**: exact SQL, owner privileges, RLS, auth accessor and transaction tests required |
| 1a. Tenant owner provisioning | `20261123_tenant_scope_rpc_owner_role_candidate.sql` | Stage 0 | NOLOGIN/NOBYPASSRLS role; trusted `postgres` membership solely for ownership transfer | Design only; membership is not runtime authority |
| 1b. Tenant owner privileges | `20261123_tenant_scope_rpc_owner_privilege_candidate.sql` | Stages 0–1 and 1a | `happy_tenant_scope_rpc_owner` | Design only; validate function signatures and lock-only RLS policies |
| 2. Execution request + approval envelope | `20261121_authenticated_execution_envelope_candidate.sql` | Stages 0–1; persisted tenant records | Separate create and decision owners | **BLOCKED**: approval binding and immutable evidence tests required |
| 2a. Create/resolve owner | `20261123_execution_request_create_owner_role_candidate.sql`, `20261123_execution_request_create_owner_privilege_candidate.sql` | Stages 0–1; envelope objects/functions | `happy_execution_request_create_rpc_owner` | Design only; exact function signatures and self-execution/approval constraints must pass |
| 2b. Founder decision owner | `20261123_execution_request_decision_owner_role_candidate.sql`, `20261123_execution_request_decision_owner_privilege_candidate.sql` | Stages 0–1; envelope objects/functions | `happy_execution_request_decision_rpc_owner` | Design only; founder identity, approval separation, stale decision and membership revocation tests required |
| 3. Human-session durable scheduler base | `20261121_durable_mission_scheduler_candidate.sql` | Stages 0–2 | Dedicated NOLOGIN/NOBYPASSRLS scheduler owner to be finalized | **BLOCKED**: graph integrity, retry exhaustion, approval-envelope binding, immutable outbox, idempotency and owner grants need closure |
| 4. Worker principal registry | `20261122_worker_principal_registry_candidate.sql` | Stages 0–3 | `happy_worker_registry_owner` | Design only; live dedicated-login identity and exact owner privileges required |
| 4a. Registry owner provisioning/privileges | `20261123_worker_registry_owner_role_candidate.sql`, `20261123_worker_registry_owner_privilege_candidate.sql` | Stages 0–3 | `happy_worker_registry_owner` | Design only; registry and tenant-grant lock/write boundaries must pass |
| 5. Worker scheduler RPCs | `20261122_worker_scheduler_rpc_candidate.sql` | Stages 0–4 | `happy_worker_scheduler_rpc_owner`, calling registry helpers | **BLOCKED**: must derive principal from live PostgreSQL `session_user`; no API/JWT fallback |
| 5a. Scheduler owner provisioning/privileges | `20261123_worker_scheduler_rpc_owner_role_candidate.sql`, `20261123_worker_scheduler_rpc_owner_privilege_candidate.sql` | Stages 0–5 | `happy_worker_scheduler_rpc_owner` | Design only; exact signatures, CONTROL/VERIFY policy separation and function ownership tests required |
| 5b. Worker RPC grants | `20261123_worker_registry_helper_grant_candidate.sql`, `20261123_worker_scheduler_rpc_grant_candidate.sql` | Stages 0–5a **and live identity gate** | Explicit registered worker LOGIN roles only | **WITHHELD** until dedicated LOGIN and pooler-preserved `session_user` verified |
| 6. Runtime integration | TypeScript Vercel worker runtime | Stages 0–5b | Verified Vercel OIDC workload identity + dedicated PostgreSQL LOGIN/pool | Not connected; verify issuer, audience, subject, environment, expiry, replay/revocation and actual pooler behavior |

## Canonical identity blocker audit

- Detailed P0/P1 findings and remediation gates are recorded in `canonical-identity-file-mutation-baseline-blocker-audit-2026-11-23.md`.
- The Stage 0 file-mutation candidate remains blocked; its broad `service_role` table grants and unowned SECURITY DEFINER consume RPC must be redesigned before any migration chain is authored.

## Explicitly superseded or excluded inputs

- `20261121_authenticated_execution_request_rpc_candidate.sql` is a non-executable superseded note. Do not treat it as a schema prerequisite; final create/resolve RPC definitions are in the execution-envelope draft and must be audited there.
- `20261121_authenticated_tenant_context_rpc_candidate.sql` is now a non-executable superseded note because its former BYPASSRLS owner suggestion conflicts with the current NOBYPASSRLS policy. Do not include it in a migration.
- The canonical file-mutation candidate is not automatically approved merely because it is the earliest dated draft. Its broad `service_role` table grants and endpoint exposure require separate redesign/review.
- Worker registry and scheduler grant candidates remain operator-reviewed design drafts, not executable migrations.

## Global owner-role invariants

Every application function-owner role must be:
`NOLOGIN NOINHERIT NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION NOBYPASSRLS`.

- No owner membership for `anon`, `authenticated`, `service_role`, `authenticator`, or any `happy_worker_*` LOGIN.
- The documented `postgres` membership exists only to transfer ownership during a controlled migration; it is not a runtime membership grant.
- No owner role owns schemas, tables, databases, or broad application objects.
- Temporary schema `CREATE` used for `ALTER FUNCTION ... OWNER TO` must be revoked in the same transaction.
- Every SECURITY DEFINER function must have a fixed safe `search_path`, explicit owner, exact signature, explicit EXECUTE revoke, and a narrowly scoped grant.
- Never use a BYPASSRLS owner as a shortcut. Test actual RLS and SQL privilege behavior together.
- Do not grant worker LOGIN roles table access. Worker runtime authority is via capability-scoped RPC EXECUTE grants only.
- No worker RPC grants until a real dedicated LOGIN proves its database identity through the actual supported connection/pooler path.

## Required acceptance evidence before staging apply

1. Static draft contract passes, including exact function signature ↔ grant matching.
2. Dependency manifest matches the actual SQL object references; no superseded draft is included.
3. Each function owner has exact schema, table, column, and helper-function privileges; no excess privileges.
4. PostgreSQL 17 adversarial tests pass for RLS, FOR SHARE locks, forbidden updates, owner role attributes, and membership graph.
5. Authenticated tests pass with real Supabase JWTs: tenant isolation, revoked membership, self-approval denial, immutable envelope, stale CAS and transaction rollback.
6. Worker tests pass with a dedicated LOGIN and real pooler path: `session_user`, capability revocation, tenant scope, lease fencing, late provider response, ambiguous dispatch and crash recovery.
7. Hosted advisors show no unresolved relevant security findings.
8. Migration order, checksums, backup/recovery and explicit staging approval are recorded.

**Current result:** NOT READY TO APPLY. The staging project remains intentionally empty. This manifest is a review aid, not a deployment instruction.
