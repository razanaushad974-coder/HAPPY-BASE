# PR #10 source-level security audit — 2026-11-24

**Scope:** read-only review of the current `security/staging-migration-readiness` branch at the time of review. This is a source review, not a PostgreSQL execution or hosted-environment certification.

## Reviewed candidate groups

- Canonical tenant identity baseline and minimal execution-request base.
- Async tenant persistence schema and tenant-scope owner/privilege candidate.
- Authenticated execution envelope and separate create/resolve and founder-decision owner candidates.
- Worker principal registry and registry owner/privilege candidate.
- Worker scheduler RPC candidate and scheduler owner/privilege candidate.
- Existing dependency/owner manifest and static staging-draft preflight.

## Source-level checks completed

1. **Owner-role shape:** the inspected owner-role candidates declare dedicated `NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS` roles. This is source evidence only; the actual hosted role catalog remains unverified.
2. **Worker identity source:** the registry helper derives the login principal from PostgreSQL `session_user`; supplied worker and tenant identifiers are selectors that are checked against registry/grant/membership state. The real pooler path has not been tested.
3. **SECURITY DEFINER hardening:** inspected worker identity/scope and scheduler RPC definitions use a fixed `search_path = pg_catalog`; the privilege candidates transfer ownership to dedicated NOLOGIN roles and revoke temporary schema CREATE in the same transaction.
4. **Worker RPC surface:** the scheduler candidate defines eight worker RPCs. The corresponding owner-privilege candidate contains eight matching typed `ALTER FUNCTION ... OWNER TO` statements. The draft revokes default/public/API execution and intentionally withholds worker LOGIN EXECUTE grants pending the live identity gate.
5. **Tenant persistence surface:** the tenant owner candidate covers the five tenant persistence RPCs; the privilege candidate narrows helper/table/column grants and includes lock-only policy assertions.
6. **Execution request split:** create/resolve and founder decision are assigned to separate owner roles. The decision candidate checks active founder membership, rejects self-approval, constrains allowed state transitions, and binds the approval event to the updated request.
7. **Stage separation:** the isolated identity baseline and execution-request base are separated from the legacy file-mutation candidate. The legacy candidate with broad `service_role` access and an unowned SECURITY DEFINER endpoint remains excluded.

## Findings and unresolved gates

### Blockers — do not apply

- There is still no checked-in `supabase/config.toml` or ordered `supabase/migrations/` chain. The SQL files remain drafts; no clean-database replay has been demonstrated.
- The current review does not establish the actual hosted PostgreSQL role attributes, object owners, grants, RLS policies, or extension/function availability.
- No adversarial integration run with real Supabase JWTs has established tenant isolation, membership revocation, self-approval denial, immutable approval evidence, stale-CAS behavior, and rollback against the composed schema.
- No dedicated worker LOGIN has been exercised through the actual supported pooler path. Therefore `session_user` preservation and worker identity cannot be considered proven.
- Full hosted scheduler integration, including lease fencing, CONTROL/VERIFY separation, ambiguous dispatch, provider late responses, and crash recovery, remains unverified.
- The full role/policy/function matrix still requires replay against an empty PostgreSQL 17 database and catalog assertions after each ordered stage.

### No release authorization

This audit does **not** promote any draft to a migration, approve a staging apply, authorize credentials/roles/grants, or authorize production changes. Keep PR #10 Draft and keep worker RPC grants withheld until all acceptance gates are met and the operator explicitly approves the isolated staging apply.

## Verification evidence boundary

The current PR head's GitHub security-validation workflow completed successfully with 25/25 steps, and the reported Vercel checks were successful. Those results establish the configured CI/build checks only; they do not replace the database, JWT, pooler, or hosted scheduler gates above.
