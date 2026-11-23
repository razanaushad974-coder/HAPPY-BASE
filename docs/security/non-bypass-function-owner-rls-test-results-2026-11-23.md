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
4. Owner role had a SELECT policy and a lock-only UPDATE policy (`USING (tenant_id = 'tenant-a') WITH CHECK (false)`), plus SELECT and column-level `UPDATE(lock_marker)` privileges.
5. Owner role successfully executed `SELECT ... FOR SHARE` and the function explicitly asserted `FOUND = true`.
6. An UPDATE attempt was rejected by the false `WITH CHECK` expression; the stored marker remained false.
7. No `anon`, `authenticated`, `service_role`, or `authenticator` role was a member of the function owner.

The SQL assertions completed without exception. The MCP SQL response does not expose PostgreSQL NOTICE output; pass is based on successful completion of the assertion blocks and explicit post-rollback catalog verification.

### Supabase ownership nuance

The hosted `postgres` role is not a PostgreSQL superuser (`rolsuper=false`) and cannot simply assume an arbitrary newly-created NOLOGIN owner role. The probe temporarily granted the test owner role to the trusted `postgres` administrator inside the same transaction to transfer function ownership. That membership and all probe objects rolled back. The test explicitly asserts that no API role is a member of the owner role.

A production migration must use a deliberate owner-assignment path available to the actual migration executor. Do not grant function-owner membership to API roles or worker LOGIN roles as a shortcut. The exact grantor/admin-option behavior should be verified in the migration execution context before promotion.

## Important correction to worker registry RLS design

The corrected PostgreSQL 17.12 probe established:

- `SELECT ... FOR SHARE` requires SELECT plus an UPDATE SQL privilege and an UPDATE RLS policy whose `USING` expression admits the row.
- With no UPDATE policy, the locking SELECT can silently return zero rows; checking only for an exception is insufficient.
- A lock-only policy (`USING (true) WITH CHECK (false)`) permits the row lock but rejects all attempted row mutations.

The first probe did not assert `FOUND` and its initial interpretation was wrong. The corrected tests now assert the row was actually returned/locked and verify the mutation is rejected. The six worker-registry UPDATE policies are now lock-only (`USING (true) WITH CHECK (false)`), not absent and not `WITH CHECK (true)`. A six-table synthetic fixture has passed with the exact proposed SELECT columns and column-level UPDATE grants.

## Six-table worker registry privilege matrix probe

A second committed script, `scripts/security/test-worker-registry-owner-grants.sql`, also completed successfully on the same PostgreSQL 17.12 staging database in a rollback-only transaction.

It modeled the exact six registry/scope tables and the proposed column grants:

| Table | SELECT columns | Lock UPDATE column |
|---|---|---|
| `happy_worker_principal_registry` | principal ID, DB login role, issuer, subject, audience, environment, capabilities, enabled, activated_at, revoked_at | enabled |
| `happy_worker_tenant_grants` | principal ID, organization ID, workspace ID, user ID, capabilities, enabled | enabled |
| `organizations` | organization ID, status | status |
| `workspaces` | organization ID, workspace ID, status | status |
| `organization_memberships` | organization ID, user ID, status | status |
| `workspace_memberships` | organization ID, workspace ID, user ID, status | status |

For all six tables, the test asserted:
- the NOLOGIN/NONINHERIT/NOBYPASSRLS owner could find and lock the intended row using `FOR SHARE`;
- the lock-only UPDATE policy used `USING (true) WITH CHECK (false)`;
- attempted UPDATE operations were rejected;
- API roles were not members of the owner role.

The script blob SHA was `fa3d58d9a8ce196b0af41ec522d2f057f707c043`. A final catalog check confirmed both probe roles and all five probe schemas were absent after rollback.

This validates the proposed registry-owner privilege pattern against a six-table synthetic fixture. It is not yet a test against the actual HAPPY tables, because the staging project intentionally has no HAPPY schema or migrations.

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

**Disposition: PARTIAL PASS — non-bypass SECURITY DEFINER owner mechanics and the corrected lock-only RLS pattern passed rollback-only PostgreSQL 17.12 probes, including a six-table synthetic registry fixture. Exact grants on the real HAPPY tables, scheduler write policies, and concurrent revocation tests remain BLOCKED.**
