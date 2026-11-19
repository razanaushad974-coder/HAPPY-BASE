# Supabase project security baseline — 2026-11-19

## Scope and method

Read-only inspection of the connected Supabase project `hsuxeebljhjwyxeuztzz` (PostgreSQL 17.6). No SQL writes, DDL, migration, Auth configuration change, or deployment was performed.

## Schema and migration baseline

- The all-schemas table inventory returned no HAPPY application tables. The result included Supabase/system schemas; this is not evidence that system schemas are empty.
- The migration-history endpoint returned no migration rows.
- The existing HAPPY PR #8 branch therefore has no confirmed deployed organization/workspace membership schema or durable approval-grant table to target.
- Do not implement a grant-store adapter against guessed table names, and do not enable FILE access until the canonical membership schema and trusted execution-request source are agreed and implemented.

## Security advisor findings

The Supabase Security Advisor returned three warnings at `2026-11-19T07:50:51.475Z`:

1. `public.rls_auto_enable()` is flagged as a SECURITY DEFINER function executable by `anon`.
2. The same function is flagged as executable by `authenticated`.
3. Supabase Auth leaked-password protection is disabled.

Remediation references:

- [SECURITY DEFINER executable by anon](https://supabase.com/docs/guides/database/database-linter?lint=0028_anon_security_definer_function_executable)
- [SECURITY DEFINER executable by authenticated](https://supabase.com/docs/guides/database/database-linter?lint=0029_authenticated_security_definer_function_executable)
- [Leaked password protection](https://supabase.com/docs/guides/auth/password-security#password-strength-and-leaked-password-protection)

## `rls_auto_enable()` verification

Read-only catalog inspection confirmed:

- Function signature: `public.rls_auto_enable()`.
- Return type: `event_trigger`.
- `SECURITY DEFINER` is enabled; owner is `postgres`.
- Function-level `search_path` is pinned to `pg_catalog`.
- The function body iterates DDL commands and enables RLS only for newly created table objects in `public`; exceptions are logged and swallowed.
- It is attached to the enabled `ensure_rls` event trigger for `ddl_command_end`, restricted to `CREATE TABLE`, `CREATE TABLE AS`, and `SELECT INTO`.
- Function ACL lists `anon`, `authenticated`, `postgres`, and `service_role` as EXECUTE grantees.

### Assessment

This is an existing privileged DDL event-trigger function, not a normal application RPC. Its event-trigger return type and catalog attachment mean the advisor's generic RPC wording must not be treated as proof that an untrusted caller can invoke its body directly. The `SECURITY DEFINER` event-trigger body is nevertheless privileged and should remain narrowly scoped. The fixed `search_path=pg_catalog` is a positive control.

The current body only enables RLS on newly created `public` tables; it does not create policies, prove tenant isolation, or protect tables in other schemas. It also catches all exceptions, so a failed RLS enablement is only logged. Every application table still needs explicit RLS policies and independent verification.

### Recommended remediation (not applied)

1. Review the event trigger's intended ownership and lifecycle with the project owner before changing it.
2. Consider revoking function EXECUTE from `anon` and `authenticated`, retaining only the privileges required by the event-trigger owner and administrators. Confirm event-trigger behavior in a disposable PostgreSQL environment first; do not assume a privilege change is harmless without testing DDL creation.
3. Keep the event-trigger function out of the exposed API surface if project configuration permits; do not add an RPC wrapper.
4. Do not disable or replace `ensure_rls` as part of the FILE-grant workstream.
5. Enable Supabase Auth leaked-password protection through reviewed Auth configuration after owner approval; this setting was not changed.
6. After any approved remediation, rerun Security Advisor and verify both event-trigger behavior and effective table RLS/policies.

## Current integration blockers for HAPPY FILE authorization

- No confirmed organization/workspace/membership tables.
- No durable server-owned execution-request record from which to derive requester identity.
- No persisted approval-decision/grant table or atomic consume function.
- No production Supabase membership provider, grant-store adapter, approval route, or server composition wiring on PR #8.
- FILE READ and FILE mutations must remain default-deny.

## Supabase platform compatibility notes

The current Supabase changelog includes the CLI v3 local-by-default behavior and confirms hosted changes; pin/inspect CLI version and use explicit project targeting before any future schema workflow. Public tables are no longer automatically exposed through the Data API on all projects (enforced October 30, 2026), so API exposure must be intentional and separate from RLS. The project's current PostgreSQL version and existing security advisor results should be rechecked before implementation.

Sources:

- [Supabase breaking-change changelog](https://supabase.com/changelog?types=breaking-change)
- [Supabase SSR client guidance](https://supabase.com/docs/guides/auth/server-side/creating-a-client)
