# PostgreSQL 17 row-lock privilege probe — 2026-11-23

## Result

**PASS — disposable transaction probe completed on the empty `happy-worker-staging` Supabase project.**

- Project ref: `kcbbfwtvkjepvtbmbrse`
- Database: `postgres`
- PostgreSQL version: `17.12` (verified before this probe)
- Probe ran inside one explicit transaction and ended with `ROLLBACK`.
- Post-run verification confirmed both `happy_for_share_probe` schema and `happy_for_share_probe.scope_rows` table were absent.

## Observed behavior

The probe used the built-in `authenticated` role because the hosted `postgres` role can `SET ROLE authenticated`, while it cannot set role to an ad-hoc role created in the same transaction without membership.

1. **SELECT-only case:** role had schema USAGE, table SELECT, and a matching SELECT RLS policy, but no UPDATE privilege. `SELECT ... FOR SHARE` raised `insufficient_privilege`, as expected.
2. **Column-grant case:** after granting `UPDATE (lock_marker)` only, `SELECT ... FOR SHARE` succeeded.
3. **Mutation guard:** there was no UPDATE RLS policy. An UPDATE targeting `lock_marker` affected zero rows, as expected.

The SQL assertions completed without exception. The MCP SQL result did not surface PostgreSQL NOTICE messages, so the pass determination is based on successful completion of both assertion blocks plus the explicit post-rollback absence check.

## Hosted role observations

A read-only inspection of the current staging database role returned:

- `session_user = postgres`, `current_user = postgres`
- `rolsuper = false`
- `rolcreaterole = true`
- `rolinherit = true`
- `rolbypassrls = true`
- `rolcanlogin = true`

The current `postgres` role has membership in `authenticated`, `anon`, `authenticator`, and `service_role`; it does not have membership in `supabase_admin`.

## What this establishes — and what it does not

This confirms PostgreSQL 17.12 requires an UPDATE privilege for `FOR SHARE`, and that a column-scoped UPDATE grant can satisfy the lock privilege check while RLS without an UPDATE policy prevents row mutation in this isolated fixture.

It does **not** yet prove the proposed five NOLOGIN/NOBYPASSRLS function-owner roles can safely use the same pattern against the actual HAPPY tenant tables. It also does not validate exact candidate function ownership, function-owner table/column privileges, RLS policy composition, role memberships, trigger paths, or concurrency with tenant-membership revocation.

**No HAPPY migration, role, grant, application table, or worker credential was created.** The only SQL DDL/DML was confined to the rolled-back probe transaction. No production project was accessed or modified.

## Branch limitation

The requested Supabase development branch could not be created because the connected organization is on the Free plan; Supabase returned: `Branching is supported only on the Pro plan or above`. No branch was created and no branch compute charge started. The probe therefore ran as a rollback-only transaction against the otherwise-empty staging project.
