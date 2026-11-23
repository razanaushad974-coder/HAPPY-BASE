# SECURITY DEFINER function access inventory — 2026-11-23

## Status and scope

This is a static, function-body-level inventory of the exact candidate blobs fetched from branch `security/staging-migration-readiness`. It is an input to migration design, not a deployable privilege script.

Reviewed candidate blob SHAs:

| Candidate | Blob SHA |
|---|---|
| `20261119_async_tenant_persistence_schema_candidate.sql` | `95b5df702670324bf577a7cb98e59394e474f4f1` |
| `20261122_worker_principal_registry_candidate.sql` | `000a7cdcfc7157ada81f3168d69b1900c072b7ad` |
| `20261122_worker_scheduler_rpc_candidate.sql` | `2f98b68c0917188b160611e253d385523a5d793d` |
| `20261121_authenticated_execution_request_rpc_candidate.sql` | `2e155d564a1b93ad9c25dc8334442315ffc567b3` |
| `20261121_authenticated_execution_envelope_candidate.sql` | `56abffb4cec57bd6318e7800eba8dc5e71865fab` |

No SQL was applied. No roles, grants, or credentials were created.

## 1. Function inventory

### Tenant persistence candidate

| Function | Data surface observed in body | Required SQL capability to validate |
|---|---|---|
| `public.happy_has_active_tenant_scope` | `private.organizations`, `private.workspaces`, `private.organization_memberships`, `private.workspace_memberships`; `auth.uid()` | SELECT on the four identity tables; EXECUTE on `auth.uid()` |
| `public.happy_lock_active_tenant_scope` | Same four identity tables, each locked `FOR SHARE`; `auth.uid()` | SELECT plus the exact PostgreSQL privilege required for row locking on each table; EXECUTE on `auth.uid()` |
| `public.happy_create_tenant_record` | `public.happy_tenant_records` INSERT/RETURNING; calls lock helper | INSERT and RETURNING/SELECT privileges limited to required columns; EXECUTE on lock helper and `auth.uid()` |
| `public.happy_update_tenant_record` | `public.happy_tenant_records` UPDATE/RETURNING and existence SELECT; calls lock helper | SELECT plus UPDATE on only `data`, `version`, `updated_at` (verify exact column list); EXECUTE on lock helper and `auth.uid()` |
| `public.happy_delete_tenant_record` | `public.happy_tenant_records` DELETE and existence SELECT; calls lock helper | SELECT plus DELETE; EXECUTE on lock helper and `auth.uid()` |

**Important:** The row-lock privilege requirement must be tested against PostgreSQL 17.12 rather than guessed. Do not grant table-wide UPDATE simply to make `FOR SHARE` work. If the exact required privilege cannot be restricted safely, redesign the helper/table access model before writing grants.

### Worker principal registry candidate

| Function | Data surface observed in body | Required SQL capability to validate |
|---|---|---|
| `private.happy_worker_capabilities_valid` | No table access | No table grants; pure validation helper |
| `private.happy_require_worker_principal` | `pg_catalog.pg_roles`; `private.happy_worker_principal_registry` SELECT with `FOR SHARE`; identity from `session_user` | SELECT on catalog view and registry; exact row-lock privilege on registry; no caller-supplied identity accepted as DB principal |
| `private.happy_require_worker_tenant_scope` | Calls principal helper; `private.happy_worker_tenant_grants` SELECT with `FOR SHARE`; canonical organization/workspace/membership rows | EXECUTE on principal helper; SELECT and exact row-lock privileges on tenant grants and the four identity tables |

The helper must continue to derive the DB login from PostgreSQL `session_user`. The RPC argument `p_worker_principal_id` is only a selector that must match the registry row derived from the live session; it is not proof of identity.

### Worker scheduler candidate

All eight worker RPCs call `private.happy_require_worker_tenant_scope`. The CONTROL operations require CONTROL capability; the reconciliation operations require VERIFY capability.

| Function | Tables read / locked | Mutations observed |
|---|---|---|
| `happy_worker_claim_mission_task` | `public.happy_tenant_records` mission/task rows; `public.happy_mission_task_leases`; `private.execution_requests` | UPDATE mission/task records; INSERT lease |
| `happy_worker_enqueue_mission_dispatch` | `public.happy_mission_task_leases`; `private.execution_requests`; existing outbox/idempotency rows | INSERT `public.happy_execution_dispatch_outbox` |
| `happy_worker_heartbeat_mission_task_lease` | `public.happy_mission_task_leases` | UPDATE lease expiry/timestamp |
| `happy_worker_claim_dispatch_outbox` | `public.happy_execution_dispatch_outbox`; `public.happy_mission_task_leases` | UPDATE outbox claim state |
| `happy_worker_claim_next_dispatch_outbox` | `public.happy_mission_task_leases`; `public.happy_execution_dispatch_outbox`; `private.execution_requests` | UPDATE selected outbox claim state |
| `happy_worker_record_dispatch_outcome` | Outbox, lease, tenant mission/task records, `private.execution_requests` | UPDATE outbox, mission/task records, execution request status |
| `happy_worker_append_dispatch_reconciliation_evidence` | Outbox and existing evidence/idempotency rows | INSERT `public.happy_dispatch_reconciliation_evidence` |
| `happy_worker_list_dispatch_reconciliation_evidence` | Tenant mission/task records, outbox, reconciliation evidence | Read-only SELECT |

The table above is a conservative surface inventory. Before a grant script is authored, each function still needs a line-by-line projection of SELECT columns, UPDATE columns, row-lock clauses, INSERT columns/RETURNING columns, conflict clauses, and trigger side effects. In particular, the outbox and lease paths must be checked for immutable-column protection and for whether a function can update only the intended state columns.

### Authenticated execution-request candidates

| Function | Data surface observed in body | Required SQL capability to validate |
|---|---|---|
| `public.resolve_authenticated_execution_request(text)` (first candidate) | `private.execution_requests` SELECT; `auth.uid()` | SELECT only on returned/filter columns; EXECUTE on `auth.uid()` |
| `public.create_authenticated_execution_request(...)` | Canonical identity tables; `public.happy_tenant_records`; `private.execution_requests` INSERT then SELECT persisted idempotency row; `auth.uid()`, digest helper | SELECT on identity and mission/task records; INSERT plus SELECT on exact request columns; EXECUTE on required auth/digest helpers |
| `public.resolve_authenticated_execution_request(text)` (envelope candidate replacement) | `private.execution_requests` SELECT; `auth.uid()` | SELECT only on returned/filter columns; EXECUTE on `auth.uid()` |
| `public.decide_authenticated_execution_request(...)` | Organizations, workspaces, organization/workspace memberships, execution request; approval-event idempotency check | SELECT and required row-lock privileges on canonical membership rows and request; narrowly scoped UPDATE on approval/status decision columns; INSERT on append-only approval evidence; SELECT for idempotency/RETURNING |
| `private.reject_execution_request_approval_event_mutation()` | No table read/write in function body; trigger raises unconditionally | Trigger function should normally be SECURITY INVOKER; no data grants required by its body |
| `private.guard_execution_request_update()` | OLD/NEW row only; trigger validation | No independent table grant required by body; SECURITY INVOKER is preferred unless a documented requirement proves otherwise |
| `private.guard_execution_request_insert()` | NEW row only; trigger validation | No independent table grant required by body; SECURITY INVOKER is preferred unless a documented requirement proves otherwise |

The two definitions of `public.resolve_authenticated_execution_request(text)` are successive candidate revisions; the migration chain must create exactly one final definition and test its final grants. Do not combine grants from both drafts blindly.

## 2. Owner assignment and privilege boundaries

The intended split remains:

- `happy_tenant_scope_rpc_owner`: tenant scope helpers and tenant record RPCs, only after their function bodies and RLS behavior are reconciled.
- `happy_execution_request_create_rpc_owner`: request creation only.
- `happy_execution_request_decision_rpc_owner`: founder decision and append-only evidence only.
- `happy_worker_registry_owner`: worker principal and worker tenant scope helpers.
- `happy_worker_scheduler_rpc_owner`: worker claim, dispatch, heartbeat, outcome and reconciliation operations.

Every owner must be `NOLOGIN`, `NOINHERIT`, `NOBYPASSRLS`, `NOSUPERUSER`, `NOCREATEROLE`, `NOCREATEDB`, and `NOREPLICATION`. No worker LOGIN, `service_role`, `authenticated`, or `anon` role may be a member of an owner role. Owner roles must not inherit privileges through other memberships.

The existing execution-request candidates create three BYPASSRLS owners. Those definitions must be replaced, not retained or normalized by a later GRANT statement.

## 3. Additional blockers discovered by body inventory

1. The worker scheduler bodies directly touch `private.execution_requests` as well as public scheduler tables. The scheduler owner therefore crosses the approval-request data boundary. Decide whether this is acceptable or split the request-status transition into a separate narrow function/owner before granting scheduler access.
2. The scheduler functions update `public.happy_tenant_records` mission/task snapshots. Their UPDATE surface must be limited to the exact `data`, `version`, and timestamp columns; the immutable tenant key columns must never be writable by the worker owner.
3. The authenticated decision function row-locks organization, workspace, request and membership records. Its concurrency protocol and exact row-lock privileges must be tested against concurrent membership revocation.
4. The trigger guard functions in the envelope candidate are declared SECURITY DEFINER even though their visible bodies validate OLD/NEW row values and do not need privileged table reads. Prefer SECURITY INVOKER and revoke unnecessary function EXECUTE grants unless a concrete trigger-specific requirement is demonstrated.
5. Registry and tenant-grant helpers use `FOR SHARE`; their row-lock privilege requirement must be validated. Do not solve this by granting broad UPDATE or BYPASSRLS.
6. Candidate-level references to `extensions.digest`, `private.happy_canonical_jsonb`, `auth.uid()`, and other helper functions need explicit EXECUTE checks and fixed-schema resolution. Function calls made inside SECURITY DEFINER code must not rely on an attacker-controlled search path.

## 4. Required next implementation gate

Before producing migration SQL:

1. Extract every table definition, constraint, RLS policy, trigger, and function signature from the prerequisite candidates.
2. Build per-function column-level access lists, including implicit RETURNING, conflict handling, row locks and trigger side effects.
3. Run disposable PostgreSQL 17.12 tests for each owner role with NOBYPASSRLS and the proposed exact grants. Assert both intended success and forbidden operations.
4. Test whether `SELECT ... FOR SHARE` works with the proposed least-privilege grants; document the minimum required privilege from observed PostgreSQL behavior.
5. Test concurrent membership revocation against tenant scope locks and approval decisions.
6. Only then write ordered Supabase migration files using the repository's pinned Supabase CLI workflow. Keep all worker RPC EXECUTE grants withheld until dedicated `session_user` identity is proven through the actual hosted connection path.

## 5. Explicit non-actions

- No staging SQL, DDL, migrations, roles, grants, passwords, or registry rows were created.
- No production database, deployment, or project was modified.
- This inventory is not a deployment approval and is not a deployable SQL script.

**Disposition: BLOCKED — exact column grants and non-bypass owner behavior still require disposable PostgreSQL 17.12 verification.**
