# Non-bypass function-owner RLS probe and worker registry policy correction — 2026-11-23

## Hosted PostgreSQL test result

**PASS — exact committed probe completed on the empty `happy-worker-staging` project (PostgreSQL 17.12).**

- Project ref: `kcbbfwtvkjepvtbmbrse`
- Database: `postgres`
- Test script: `scripts/security/test-non-bypass-function-owner-rls.sql`
- Script blob SHA: `1e8d8f4eca89cc80b935788cabef72fa48438b99`
- SQL ran inside one explicit transaction and ended with `ROLLBACK`.
- Post-run catalog checks confirmed the probe role, schema, and table were absent.

### Assertions exercised

1. Function owner was `NOLOGIN`, `NOINHERIT`, `NOSUPERUSER`, `NOCREATEROLE`, `NOCREATEDB`, `NOREPLICATION`, and `NOBYPASSRLS`.
2. The SECURITY DEFINER function owner was explicitly assigned and used fixed `search_path = pg_catalog`.
3. The authenticated caller could invoke only the explicitly granted function; it was not a member of the owner role.
4. Owner role had SELECT policy and SELECT privilege, plus column-level `UPDATE(lock_marker)`.
5. Owner role successfully executed `SELECT ... FOR SHARE`.
6. There was no UPDATE RLS policy. An UPDATE attempt affected zero rows and the stored marker remained false.
7. No `anon`, `authenticated`, `service_role`, or `authenticator` role was a member of the function owner.

The SQL assertions completed without exception. The MCP SQL response does not expose PostgreSQL NOTICE output; pass is based on successful completion of the assertion blocks and explicit post-rollback catalog verification.

### Supabase ownership nuance

The hosted `postgres` role is not a PostgreSQL superuser (`rolsuper=false`) and cannot simply assume an arbitrary newly-created NOLOGIN owner role. The probe temporarily granted the test owner role to the trusted `postgres` administrator inside the same transaction to transfer function ownership. That membership and all probe objects rolled back. The test explicitly asserts that no API role is a member of the owner role.

A production migration must use a deliberate owner-assignment path available to the actual migration executor. Do not grant function-owner membership to API roles or worker LOGIN roles as a shortcut. The exact grantor/admin-option behavior should be verified in the migration execution context before promotion.

## Important correction to worker registry RLS design

The PostgreSQL 17.12 row-lock probe established:

- `SELECT ... FOR SHARE` requires SELECT plus an UPDATE SQL privilege.
- It does **not** require an UPDATE RLS policy.
- With a column-level UPDATE privilege but no UPDATE policy, the row lock succeeds and UPDATE affects zero rows.

The worker registry candidate previously created six UPDATE policies with `USING (true) WITH CHECK (true)` for `happy_worker_registry_owner`, describing them as necessary for `FOR SHARE`. That is incorrect and unnecessarily creates a row-mutation authorization path.

Those six UPDATE policies have now been removed from `supabase/drafts/20261122_worker_principal_registry_candidate.sql`. The candidate now documents that a narrow column-level UPDATE privilege may be required for row-lock syntax, but UPDATE policies must remain absent for these owner roles. The exact columns and grants are still to be designed and tested against the real table definitions.

## Remaining blockers — not resolved by this probe

1. Derive exact SELECT columns, row-lock UPDATE columns, and actual UPDATE columns for each of the five function-owner roles from every function body, including `SELECT * INTO rowtype`, `RETURNING`, conflict handling, triggers, and nested helper calls.
2. Add narrowly scoped SELECT RLS policies for `happy_tenant_scope_rpc_owner` and the other owners. The worker-registry candidate currently has SELECT policies for `happy_worker_registry_owner`, but not a complete role provisioning/ownership/grant script.
3. Ensure no UPDATE RLS policy exists for owner roles that only need `FOR SHARE`; test the catalog invariant automatically.
4. Worker scheduler functions use `FOR UPDATE` and mutate mission/task records, leases, outbox, reconciliation evidence, and `private.execution_requests`. Those paths need a separate exact write-policy design and cannot reuse the read-only registry-owner grant model.
5. The scheduler directly reads and updates `private.execution_requests`, crossing the approval/request boundary. Decide whether to split that transition into a narrowly scoped RPC or explicitly accept and constrain it.
6. The execution-request create and decision candidates still declare BYPASSRLS owners. Replace them with separate non-bypass owners and prove each function's required RLS behavior.
7. Test concurrent membership revocation and founder decision row-lock ordering with two real PostgreSQL sessions.
8. Keep all worker RPC EXECUTE grants withheld until the actual dedicated PostgreSQL LOGIN and hosted pooler `session_user` identity are verified.

## Explicit non-actions

- No HAPPY migration or candidate migration was applied.
- No persistent role, schema, table, grant, membership, or credential was created by the test.
- No worker role/password or registry record was provisioned.
- No production project was accessed or changed.

**Disposition: PARTIAL PASS — non-bypass SECURITY DEFINER owner mechanics and row-lock/RLS semantics are verified in an isolated rollback-only fixture. Exact HAPPY table grants and owner policies remain BLOCKED.**
