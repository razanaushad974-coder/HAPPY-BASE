# Function-owner privilege audit and tenant baseline gate — 2026-11-23

## Review basis

Reviewed the exact SQL candidate blobs on `platform/full-happy-audit-and-integration`:

| Candidate | Blob SHA |
|---|---|
| `20261119_file_mutation_atomic_consume_candidate.sql` | `1ebcaf92908ba3b4a9eced3460f5b9fdcdef8804` |
| `20261119_async_tenant_persistence_schema_candidate.sql` | `95b5df702670324bf577a7cb98e59394e474f4f1` |
| `20261121_authenticated_execution_request_rpc_candidate.sql` | `2e155d564a1b93ad9c25dc8334442315ffc567b3` |
| `20261121_authenticated_execution_envelope_candidate.sql` | `56abffb4cec57bd6318e7800eba8dc5e71865fab` |
| `20261122_worker_principal_registry_candidate.sql` | `000a7cdcfc7157ada81f3168d69b1900c072b7ad` |
| `20261122_worker_scheduler_rpc_candidate.sql` | `2f98b68c0917188b160611e253d385523a5d793d` |

This is a static source review, not a claim that the SQL was executed or tested on the hosted project.

## Critical correction: owner candidates currently conflict with the intended least-privilege model

The execution-request RPC candidates create owner roles with `BYPASSRLS`:

- `happy_execution_request_rpc_owner` in the authenticated request RPC candidate.
- `happy_execution_request_create_rpc_owner` in the approval-envelope candidate.
- `happy_execution_request_decision_rpc_owner` in the approval-envelope candidate.

The worker-registry candidate, in contrast, explicitly describes its function owner as `NOLOGIN`, non-`BYPASSRLS`, with narrow SELECT and row-lock permissions.

These are not interchangeable models. A role with `BYPASSRLS` defeats row-level security for every table it accesses, even if it has only SELECT on one table today. It is therefore not acceptable to describe the current candidate set as uniformly non-bypass or least-privilege. The three execution-request owner definitions are P0 review blockers and must be redesigned before any candidate is promoted.

The existing file-mutation candidate also grants `service_role` broad SELECT/INSERT/UPDATE privileges across several private identity and approval tables. This is not suitable as the final baseline without a separate review of every service-role call path and whether direct access is required. Do not apply it wholesale.

## Target owner model — no privileged owner may bypass RLS

The migration design should use separate non-login, non-inheriting, non-bypass owner roles, with explicit grants only:

| Role | Purpose | Permitted data surface |
|---|---|---|
| `happy_tenant_scope_rpc_owner` | Resolve and lock canonical organization/workspace membership for tenant-record RPCs | SELECT on organizations, workspaces, organization_memberships, workspace_memberships; only the minimum row-lock/update privilege required by verified `FOR SHARE` semantics |
| `happy_execution_request_create_rpc_owner` | Create a pending execution request and immutable request envelope | INSERT/SELECT on execution_requests; SELECT on canonical tenant/membership rows; only required helper functions |
| `happy_execution_request_decision_rpc_owner` | Record founder decision and append immutable approval evidence | SELECT/UPDATE on execution_requests; SELECT on canonical membership rows; INSERT/SELECT on approval-event rows |
| `happy_worker_registry_owner` | Resolve worker login and worker-to-tenant grants | SELECT on worker registry, worker tenant grants, and canonical tenant/membership rows; narrowly scoped row-lock privileges |
| `happy_worker_scheduler_rpc_owner` | Perform fenced claim, heartbeat, outbox, outcome and reconciliation transitions | Only scheduler/outbox/lease/evidence tables and the exact tenant/request/approval read surfaces needed by those functions |

For every role:
- `NOLOGIN`, `NOSUPERUSER`, `NOCREATEROLE`, `NOCREATEDB`, `NOREPLICATION`, `NOBYPASSRLS`, and `NOINHERIT`.
- No membership granted to worker LOGIN roles, `service_role`, `authenticated`, or `anon`.
- Schema USAGE only on schemas referenced by its owned function bodies.
- Explicit table and column privileges; no `GRANT ALL`, no schema-wide table grants, and no default privileges that silently widen access.
- Explicit RLS policies for the owner role. RLS policies do not grant SQL privileges.
- Avoid `FORCE ROW LEVEL SECURITY` changes until table ownership and every legitimate administrative/maintenance path are mapped and tested. If FORCE RLS is selected, test owner behavior explicitly; do not solve failures by granting BYPASSRLS.
- Every SECURITY DEFINER function must use a fixed `search_path` (prefer `pg_catalog` plus schema-qualified object references), have its owner assigned explicitly, and have PUBLIC/anon/authenticated/service_role EXECUTE revoked unless that role is explicitly the intended caller.
- Revoke default PUBLIC EXECUTE on all new functions in the same transaction in which they are created.

This matrix is a target architecture, not yet a deployable GRANT script. The exact privileges must be derived from each function body and exercised against the hosted PostgreSQL 17.12 behavior.

## Canonical tenant identity baseline

The minimal canonical identity tables in the file-mutation candidate are:

1. `private.organizations` — organization ID and lifecycle status.
2. `private.workspaces` — workspace ID, organization binding, and lifecycle status; unique organization/workspace pair.
3. `private.organization_memberships` — organization/user membership and role/status.
4. `private.workspace_memberships` — organization/workspace/user membership and role/status.

These four tables are the prerequisite identity layer for:
- `happy_tenant_records` and tenant CAS RPCs;
- authenticated execution-request authorization;
- worker tenant grants and live membership revalidation;
- durable mission/task/lease/outbox ownership.

The current file-mutation candidate bundles these identity tables with execution-request and file-mutation approval tables and a public file-mutation consumption RPC. That bundle should be decomposed into dependency-cohesive migrations, not copied wholesale as the first tenant baseline.

### Baseline design requirements

- Keep identity and membership tables in the non-exposed `private` schema.
- Use UUID primary/foreign keys and composite foreign keys to enforce organization/workspace consistency.
- Use restrictive deletes for organization, workspace and user references; lifecycle changes should be explicit status transitions, not cascading tenant deletion.
- Constrain statuses and role vocabulary; define who can grant/revoke FOUNDER, OWNER, ADMIN and MEMBER roles. Never accept a caller-provided role as authority.
- Define unique constraints and indexes for both membership lookup directions and foreign-key paths.
- Enable RLS on all private tables as defense in depth. Grant no direct table access to `anon`, `authenticated`, or `service_role` unless a specific reviewed call path requires it.
- Use authenticated `auth.uid()` for user-facing membership decisions; never trust user-editable `user_metadata` for authorization.
- Worker authorization must use the verified PostgreSQL `session_user` identity and registry, then re-check active tenant grants and canonical membership in the same transaction.
- No initial tenant or founder membership may be inferred from a client-supplied UUID. Bootstrap must be an operator-controlled, auditable process.

## Function-specific issues to resolve before writing migrations

1. The async tenant persistence candidate has four SECURITY DEFINER functions but leaves function-owner, schema/table grants and RLS behavior unresolved. It explicitly calls out this blocker.
2. The worker registry candidate has policies for `happy_worker_registry_owner`, but its owner role and complete SQL privileges are not provisioned by that candidate.
3. The worker scheduler candidate defines eight worker operations and withholds EXECUTE grants; its SECURITY DEFINER ownership and underlying table grants remain unprovisioned.
4. The authenticated execution-request RPC candidate's owner is explicitly created with BYPASSRLS; replace this model, do not carry it forward.
5. The approval-envelope candidate creates separate create/decision owners with BYPASSRLS. Replace both models with non-bypass owners and prove that RLS plus narrow privileges permit only the exact operations.
6. The file-mutation candidate grants broad private-table access to `service_role` and exposes a public SECURITY DEFINER consume RPC to authenticated users. Keep this separate from the worker baseline and review its caller identity, approval binding and function owner independently.

## Required validation matrix

Before staging application, run tests on a disposable PostgreSQL 17 database and then on the dedicated staging project:

- Inspect `pg_roles`, `pg_auth_members`, `pg_class.relowner`, `pg_proc.proowner`, `pg_proc.prosecdef`, `pg_proc.proconfig`, `information_schema.role_table_grants`, and `pg_policies`.
- Assert every function owner is NOLOGIN, NOBYPASSRLS, NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOREPLICATION and NOINHERIT.
- Assert no API role or worker LOGIN is a member of an owner role.
- Assert no owner has unexpected table/column privileges or EXECUTE on unrelated functions.
- Verify each SECURITY DEFINER function has a fixed safe search_path and explicit owner.
- Exercise active, suspended, revoked and cross-tenant membership paths; include stale membership and concurrent revocation/locking tests.
- Exercise execution request creation, immutable envelope, founder approval and denial with altered request fields, replay, self-approval, and revoked membership.
- Exercise worker login through the actual hosted pooler; prove `session_user` is the dedicated worker login, not `postgres`, `authenticator`, or a shared pooler role.
- Verify the registry helper fails closed for missing, inactive, expired, malformed, or role-attribute-mismatched registrations.
- Run Supabase Security and Performance Advisors after each staging migration.

## Supabase platform compatibility notes

The current Supabase changelog identifies two relevant 2026 breaking changes:
- New projects and then all projects stopped automatically exposing new `public` tables through the Data API by default (enforcement date 2026-10-30). Grants and RLS remain separate controls. Do not add public API grants just to make tests pass.
- Supabase CLI v3 is local-first and confirms hosted changes; CLI scripts and CI must be checked before upgrading. Keep the project's CLI version pinned until the migration workflow is deliberately upgraded.

References:
- https://supabase.com/changelog/45329-breaking-change-tables-not-exposed-to-data-and-graphql-api-automatically
- https://supabase.com/changelog?types=breaking-change
- https://supabase.com/docs/guides/database/postgres/row-level-security

## Current disposition

`BLOCKED — DESIGN REVIEW REQUIRED`.

No SQL was applied, no roles or credentials were created, and no grants were changed. Do not create the tenant baseline migration until the BYPASSRLS owner candidates are replaced, the four identity tables are cleanly separated from file-mutation concerns, and the exact per-function privilege matrix is approved by automated tests.
