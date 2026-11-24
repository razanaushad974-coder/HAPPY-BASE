# Tenant-scope RPC owner privilege probe — 2026-11-23

## Result

**PASS — synthetic tenant-scope owner and CAS lifecycle probe completed on hosted Supabase PostgreSQL 17.12.**

- Project ref: `kcbbfwtvkjepvtbmbrse`
- Test script: `scripts/security/test-tenant-scope-owner-grants.sql`
- Script blob SHA: `e996e5cb703f73d205343aa630f348dec961fdd6`
- SQL ran in one transaction ending with `ROLLBACK`.
- Post-run catalog verification confirmed all probe roles and schemas were absent.

## What the probe exercised

1. A `NOLOGIN / NOINHERIT / NOSUPERUSER / NOCREATEROLE / NOCREATEDB / NOREPLICATION / NOBYPASSRLS` tenant-scope function owner.
2. Four canonical identity tables with SELECT policies and lock-only UPDATE policies (`USING (true) WITH CHECK (false)`).
3. Exact SELECT and column-level UPDATE grants on the four identity tables.
4. A tenant-record table with caller-bound SELECT/INSERT/UPDATE/DELETE RLS policies.
5. A private JWT-subject accessor that returns only `auth.uid()`, with fixed `search_path = pg_catalog`, SECURITY DEFINER ownership by the trusted `postgres` role, and EXECUTE granted only to the tenant-scope owner.
6. SECURITY DEFINER create, CAS update, and CAS delete paths executed as the non-bypass owner.
7. Active membership allowed create/update/delete; stale expected-version update was rejected; changing the JWT subject to an unrelated user caused the update to be denied.

The SQL assertion block completed without exception. The MCP SQL response surfaced the JWT subject setting row; no errors were returned.

## Managed auth-schema constraint discovered

On this Supabase project, the managed `auth` schema does not permit the custom NOLOGIN owner role to call `auth.uid()` directly, even after attempting a direct schema USAGE grant. The test confirmed a narrow private SECURITY DEFINER accessor can safely bridge this boundary: its body only returns `auth.uid()`, it reads no tables, has a fixed search path, and its EXECUTE ACL is limited to the tenant-scope owner.

The async tenant persistence candidate now calls `private.happy_current_authenticated_user_id()` from its SECURITY DEFINER RPC bodies. The authenticated-client RLS policies continue to use `auth.uid()` directly. The tenant owner privilege candidate creates the private accessor and grants it only to `happy_tenant_scope_rpc_owner`.

## Drafts added

- `supabase/drafts/20261123_tenant_scope_rpc_owner_role_candidate.sql`
- `supabase/drafts/20261123_tenant_scope_rpc_owner_privilege_candidate.sql`

These are design-only candidates. They are not migrations and were not applied to staging.

## Remaining gates

- Test the exact candidate SQL against the actual canonical identity and `happy_tenant_records` table definitions after a reviewed staging migration chain exists.
- Test concurrent membership revocation in two PostgreSQL sessions and verify the lock order.
- Verify all SECURITY DEFINER owners, function ACLs, role memberships, RLS policies, and column privileges from catalogs.
- Complete authenticated JWT integration tests through the actual Supabase API path; this synthetic test sets the JWT subject GUC explicitly and is not a substitute for real JWT verification.
- Do not provision worker credentials or grant worker RPC EXECUTE until the dedicated PostgreSQL LOGIN and hosted pooler `session_user` are verified.

**Disposition: PARTIAL PASS — tenant-scope owner/RLS/CAS mechanics are validated against a synthetic PostgreSQL 17.12 fixture. Actual HAPPY schema integration and concurrency verification remain pending.**
