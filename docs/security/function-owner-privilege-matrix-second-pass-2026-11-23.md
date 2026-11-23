# HAPPY function-owner and privilege design — second-pass audit (2026-11-23)

Status: **DESIGN REVIEW — NOT DEPLOYABLE**. This document is a static review of the exact SQL candidate revisions listed below plus a read-only inventory of the dedicated staging project. It is not a migration or grant script.

## Evidence boundary

- PostgreSQL staging project `happy-worker-staging` (ref `kcbbfwtvkjepvtbmbrse`) reported PostgreSQL **17.12**, `current_user = postgres`, `session_user = postgres`, **0 `happy_%` roles**, and **0 application tables** at the time of this audit.
- The earlier rollback-only PostgreSQL 17.12 lock probe established: `SELECT` alone is insufficient for `SELECT ... FOR SHARE`; adding an UPDATE privilege on one inert column permits the row lock; with no matching UPDATE RLS policy, an UPDATE affects zero rows. This validates a possible lock-privilege pattern, not the complete owner design.
- No migration, role, grant, table, credential, or application schema was created by this audit. No production project was accessed or changed.

## Exact source revisions audited

| Candidate | Blob SHA |
|---|---|
| `20261119_file_mutation_atomic_consume_candidate.sql` | `1ebcaf92908ba3b4a9eced3460f5b9fdcdef8804` |
| `20261119_async_tenant_persistence_schema_candidate.sql` | `2f3772697985050dc97618dd7dfd41438bdea139` |
| `20261121_authenticated_execution_envelope_candidate.sql` | `24768a5058e0fa42cb3a28ccd72aa2664a4b2e6d` |
| `20261122_worker_principal_registry_candidate.sql` | `412202c5e72ceec7d92957e30134e1ef75adba6d` |
| `20261122_worker_scheduler_rpc_candidate.sql` | `2f98b68c0917188b160611e253d385523a5d793d` |

## Five function-owner roles — required invariant

All five roles must be explicitly provisioned as:
- `NOLOGIN NOINHERIT NOBYPASSRLS NOSUPERUSER NOCREATEROLE NOCREATEDB NOREPLICATION`
- no role memberships (neither as member nor granted-role path), no database/schema ownership, and no ownership of application tables;
- own only their assigned SECURITY DEFINER functions;
- have a fixed, reviewed function `search_path` (prefer empty path with every object schema-qualified; current candidates generally pin `pg_catalog`, so extension/helper qualification must be verified);
- receive only explicit schema USAGE, table/column privileges, policy access, and helper EXECUTE privileges listed in a final reviewed migration;
- no default PUBLIC EXECUTE, and no EXECUTE for `anon`, `authenticated`, or `service_role` on worker-only private RPCs.

Roles:
1. `happy_tenant_scope_rpc_owner`
2. `happy_execution_request_create_rpc_owner`
3. `happy_execution_request_decision_rpc_owner`
4. `happy_worker_registry_owner`
5. `happy_worker_scheduler_rpc_owner`

## Per-owner access boundary (review matrix)

### 1. `happy_tenant_scope_rpc_owner`

Owns the tenant scope and tenant-record SECURITY DEFINER RPCs. Required data paths:
- Read and lock `private.organizations`, `private.workspaces`, `private.organization_memberships`, and `private.workspace_memberships` in the fixed lock order.
- Read/write `public.happy_tenant_records` only through the scoped create/CAS operations; writes must be limited to mutable payload/version/timestamp fields. Tenant key columns (`organization_id`, `workspace_id`, `user_id`, `entity_type`, `record_id`) must never be writable through the UPDATE path.
- Call the narrowly scoped authenticated-subject helper and the required tenant-scope helper functions.

The `FOR SHARE` probe means each private identity relation needs a deliberately inert column-level UPDATE privilege for this owner if the final function retains `FOR SHARE`. That privilege must not be paired with an UPDATE RLS policy that permits row mutation. Prefer a dedicated lock-anchor column over reusing business columns, after confirming migration/trigger compatibility. The owner also needs SELECT RLS visibility for exactly the rows in the requested scope.

### 2. `happy_execution_request_create_rpc_owner`

Owns authenticated request creation and resolution functions. Required data paths:
- Verify the caller and active organization/workspace/membership scope using the tenant helper chain.
- Read the exact same-user/same-tenant mission and task records from `public.happy_tenant_records`; verify the graph references agree.
- Insert the immutable request envelope into `private.execution_requests`; resolve/read only the request bound to the authenticated user and complete tenant scope.
- Call the canonical JSON/digest helpers with explicit EXECUTE grants and schema qualification.

Do not grant broad table UPDATE/DELETE. The request envelope and its approval binding must remain immutable after creation except for fields whose lifecycle transition is explicitly owned by the decision/scheduler paths. The file-mutation candidate's broad `service_role` access to private tables is a separate blocker and must not be reused as this function owner's privilege model.

### 3. `happy_execution_request_decision_rpc_owner`

Owns the authenticated founder/approver decision RPC. Required data paths:
- Read and row-lock organization, workspace, organization membership, workspace membership, and the exact execution-request row.
- Update only decision/lifecycle fields on `private.execution_requests` (decision status, decided-at, decided-by, reason, and only other explicitly approved transition fields).
- Insert append-only rows into `private.execution_request_approval_events`; no UPDATE or DELETE on approval events.
- Validate approver identity/role and exact tenant/request binding before writing.

The row-lock probe applies here too: the identity/request rows need SELECT visibility and a lock-only privilege for `FOR SHARE`. Do not solve this with BYPASSRLS or table-wide UPDATE. Membership-revocation concurrency remains an explicit test gate.

### 4. `happy_worker_registry_owner`

Owns only worker identity and worker tenant-grant validation helpers. Required data paths:
- Read `private.happy_worker_principal_registry` and `private.happy_worker_tenant_grants`.
- Read/lock the four canonical identity/membership relations to recheck current status and tenant membership.
- Derive the actual worker identity from PostgreSQL `session_user`; supplied worker ID, user ID, tenant IDs, and capability are selectors only.
- No worker registry or tenant-grant mutation path is owned by this role. Provisioning, activation, and revocation remain a separate trusted operator workflow.

The current registry candidate already sketches SELECT RLS policies and a non-permissive UPDATE policy for lock semantics. It still needs a final column-level privilege design, explicit RLS policy coverage on all canonical relations, proof that the owner cannot mutate rows, and a live role/session test. The role must not be a member of `postgres`, `service_role`, or another privileged role.

### 5. `happy_worker_scheduler_rpc_owner`

Owns the eight worker-only scheduler RPCs. The static body scan found these write paths:
- `public.happy_tenant_records`: mission/task snapshot updates (only the mutable `data`, `version`, and `updated_at` fields; never tenant key columns).
- `public.happy_mission_task_leases`: lease create/claim/heartbeat/fencing state transitions.
- `public.happy_execution_dispatch_outbox`: enqueue/claim/outcome state transitions.
- `public.happy_dispatch_reconciliation_evidence`: append-only evidence inserts; list operation is scoped read-only.
- `private.execution_requests`: outcome-driven lifecycle/status update.

This role also calls `happy_require_worker_tenant_scope`, canonical JSON/digest helpers, and related internal functions. Exact per-column INSERT/UPDATE/SELECT privileges and matching owner-targeted RLS policies must be derived from every statement in the eight function bodies before any grant SQL is authored. Do not grant table-wide UPDATE as a shortcut.

**Cross-domain concern:** the scheduler currently updates `private.execution_requests` directly. This couples the worker scheduler owner to approval-request storage and its RLS/ownership boundary. Before finalizing grants, choose and document one of:
- split request-status reconciliation into a narrowly scoped internal RPC owned by the execution-request lifecycle boundary; or
- explicitly accept the scheduler owner as a cross-domain writer and prove its exact status-column-only privilege, tenant/request binding, approval immutability, and concurrency behavior.

Worker RPC capability split remains: six CONTROL functions and two VERIFY evidence functions. Grant EXECUTE only to the dedicated active worker LOGIN roles with the matching registered capability. Do not grant the functions to API roles or PUBLIC.

## Trigger and helper review

- The three execution-request trigger guard functions in the audited envelope candidate are SECURITY INVOKER, not SECURITY DEFINER. Keep them INVOKER; their bodies only enforce OLD/NEW invariants and should not become privileged entry points.
- Registry helper `private.happy_require_worker_principal` and `private.happy_require_worker_tenant_scope` are SECURITY DEFINER and must be owned by `happy_worker_registry_owner`, with exact RLS/column privileges and a fixed path.
- Scheduler RPCs are SECURITY DEFINER and must be owned by `happy_worker_scheduler_rpc_owner`; no API role may execute them.
- Review every helper call transitively. In particular, schema USAGE and EXECUTE on `extensions.digest`, `private.happy_canonical_jsonb`, tenant-scope helpers, and authenticated-subject helpers must be explicit. A fixed `search_path = pg_catalog` does not make unqualified extension/helper references safe; all non-pg_catalog objects must be schema-qualified.

## Blocking decisions and tests before a deployable migration

1. Resolve scheduler-to-`private.execution_requests` coupling (split RPC or documented cross-domain status-only writer).
2. Define exact column-level grants from every SQL statement, including INSERT column lists, UPDATE SET targets, SELECT predicates/joins, RETURNING clauses, and row-locks.
3. Define SELECT and lock-only RLS policies for each owner/table. Verify lock-anchor UPDATE privilege does not create a mutation path.
4. Decide whether to add dedicated lock-anchor columns to the four identity tables and request table, or use existing non-business columns after proof.
5. Verify all five owner roles have no privileged role memberships and all forbidden role attributes are false.
6. Test SECURITY DEFINER ownership and RLS behavior as the actual owner roles (not as `postgres`), including positive and negative tenant visibility, no-row update behavior, and exact function EXECUTE grants.
7. Test concurrent membership revocation versus tenant write/approval decision; preserve deterministic lock ordering.
8. Test worker principal activation/revocation, session_user identity, six CONTROL versus two VERIFY capabilities, late provider outcomes, lease fencing, and reconciliation.
9. Run Supabase security/performance advisors after the final schema exists and validate real Supabase JWT behavior.
10. Keep the existing file-mutation candidate's broad `service_role` grants out of the new owner roles; review that candidate separately.

## Decision

**BLOCKED — DESIGN REVIEW REQUIRED.** The row-lock behavior is now empirically known on PostgreSQL 17.12, but this does not justify applying the five-owner design. Staging remains empty and production remains untouched. No grants, roles, migrations, credentials, or worker runtime connection are live.
