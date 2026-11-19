# HAPPY canonical tenant and FILE approval schema — v1 design

**Status:** design proposal only. This document is not a migration and has not been applied to Supabase.

## 1. Decision and scope

HAPPY needs one canonical tenant model before it can safely compose the existing fail-closed tenant resolver and named-executor FILE grant verifier.

The first supported model is intentionally small:

- One organization owns one or more workspaces.
- A user has an explicit organization membership.
- A user has an explicit workspace membership within that same organization.
- Every durable execution request is scoped to exactly one organization/workspace and records its requester and named executor.
- Every FILE mutation approval is a separate, immutable, exact-operation grant. Its requester, approver, and executor are distinct identity fields.
- Current membership and role are rechecked when a grant is consumed; approval-time membership alone is insufficient.

This is not a replacement for HAPPY's wider product/business model. It is the minimum security foundation for tenant-scoped execution and FILE authorization.

## 2. Canonical relational model

Use UUID primary keys for newly created organization, workspace, membership, execution-request, and grant records. Do not retrofit UUID assumptions onto legacy text IDs without a data inventory and explicit migration plan.

### 2.1 organizations

| Column | Requirement |
|---|---|
| id | UUID primary key |
| name | Non-empty display name |
| slug | Unique normalized identifier |
| status | ACTIVE, SUSPENDED, or CLOSED |
| created_at / updated_at | Server timestamps |

Organization status other than ACTIVE blocks new execution and grant consumption.

### 2.2 workspaces

| Column | Requirement |
|---|---|
| id | UUID primary key |
| organization_id | Required FK to organizations |
| name | Non-empty display name |
| slug | Unique within organization |
| status | ACTIVE, SUSPENDED, or ARCHIVED |
| created_at / updated_at | Server timestamps |

Add a unique key on (organization_id, id) so child records can use composite foreign keys and cannot accidentally pair a workspace with another organization.

### 2.3 organization_memberships

| Column | Requirement |
|---|---|
| id | UUID primary key |
| organization_id | Required FK |
| user_id | Required FK to auth.users |
| role | OWNER, ADMIN, MEMBER, or BILLING |
| status | INVITED, ACTIVE, SUSPENDED, or REVOKED |
| created_at / updated_at | Server timestamps |

Unique (organization_id, user_id). A user has at most one current membership row per organization; re-invitation/re-activation updates the lifecycle state with an audit trail rather than creating ambiguous active duplicates.

Approval-capable organization roles are OWNER and ADMIN. The existing core verifier contract uses the normalized policy roles FOUNDER and ADMIN: map organization OWNER to FOUNDER and organization ADMIN to ADMIN in the trusted server-side role mapper. Persist the normalized required role as FOUNDER or ADMIN, and recheck the underlying current organization membership role at consumption. Workspace roles never confer founder/admin approval authority. Role strings are not trusted from JWT user_metadata, request bodies, or client state.

### 2.4 workspace_memberships

| Column | Requirement |
|---|---|
| id | UUID primary key |
| organization_id | Required FK |
| workspace_id | Required composite FK (organization_id, workspace_id) to workspaces |
| user_id | Required FK to auth.users |
| role | WORKSPACE_ADMIN, EDITOR, or VIEWER |
| status | INVITED, ACTIVE, SUSPENDED, or REVOKED |
| created_at / updated_at | Server timestamps |

Unique (workspace_id, user_id). The composite workspace FK is mandatory; it prevents cross-organization workspace membership by construction.

An effective tenant actor requires both an ACTIVE organization_memberships row and an ACTIVE workspace_memberships row for the same verified user and organization/workspace. Workspace role and organization role remain separate facts; do not silently promote workspace roles into organization-wide authority.

### 2.5 execution_requests

This is the server-owned source of requester/executor identity. Never reconstruct these identities from the execution payload when resuming or consuming an approval.

| Column | Requirement |
|---|---|
| id | UUID primary key |
| organization_id, workspace_id | Required composite workspace scope |
| requester_user_id | Required FK to auth.users; immutable |
| executor_user_id | Required FK to auth.users; immutable named executor |
| created_by_user_id | Verified initiating user |
| task_id, mission_id | Optional stable HAPPY task/mission identifiers; retain exact values used by the grant |
| status | PENDING, APPROVAL_REQUIRED, APPROVED, RUNNING, COMPLETED, FAILED, CANCELLED |
| request_digest | SHA-256 of canonical immutable request envelope |
| created_at / updated_at | Server timestamps |

The requester and executor may be the same person, but the fields must remain distinct. Changing either identity requires a new execution request and a new approval; never mutate an existing request to transfer authority.

### 2.6 file_mutation_approval_grants

Use a private, non-API-exposed schema for approval records where supported by the deployment model. The exact schema placement and database role grants must be tested before implementation; do not assume that a schema name alone makes a table inaccessible.

Required fields:

- id UUID primary key.
- organization_id, workspace_id, execution_request_id.
- requester_user_id, approver_user_id, executor_user_id, each FK to auth.users.
- required_approver_role constrained to FOUNDER or ADMIN (the verifier's normalized role vocabulary; organization OWNER maps to FOUNDER, organization ADMIN maps to ADMIN).
- target_entity_type constrained to FILE.
- target_entity_id, operation, source_path, destination_path.
- input_digest as a fixed 32-byte SHA-256 value over a canonical encoding of the complete normalized operation.
- status constrained to PENDING, APPROVED, REVOKED, EXPIRED, or CONSUMED.
- approved_at, expires_at, consumed_at, revoked_at, and server timestamps.

Use composite tenant foreign keys to ensure the execution request and workspace belong to the same organization. A grant must bind to exactly one execution request and exactly one named executor. Do not support wildcard paths, wildcard operations, or “approve all future changes” grants in v1.

The approver is the actor who made the persisted approval decision; it is not inferred from the requester or executor. Preserve a decision/audit record containing the decision actor, timestamp, decision, and reason. Do not permit the requester to approve their own request unless a separate explicit policy is adopted and reviewed; v1 should deny self-approval.

## 3. Authorization invariants

A grant can be consumed only when all of the following are true in one database transaction:

1. The current request session is cryptographically verified and maps to auth.uid().
2. The execution request exists, is in an executable approval state, and its immutable requester/executor/tenant values match the grant.
3. The current authenticated user equals the grant's named executor_user_id.
4. The organization and workspace are ACTIVE.
5. The executor has current ACTIVE organization and workspace memberships in the exact scope.
6. The persisted approver has current ACTIVE organization membership and currently holds the organization role mapped to the required FOUNDER/ADMIN policy role. A revoked or downgraded approver cannot authorize consumption.
7. The grant is APPROVED, not revoked, not consumed, and expires_at is later than the database clock.
8. The operation, FILE target, source/destination paths, task/mission IDs, and digest exactly match the current normalized operation.
9. The conditional consume changes exactly one row. Zero rows means deny; more than one row is a schema/invariant failure and must abort.

Requester, approver, and executor must be recorded and independently validated. The named-executor policy does not mean “any active workspace member may execute.”

## 4. Atomic consumption contract

The production store must expose one atomic consume operation, not a read-then-write sequence:

- Lock or conditionally update the one grant row.
- Match the full immutable binding and current state.
- Check active tenant membership and current approver role in the same transaction.
- Set status to CONSUMED and consumed_at from the database clock.
- Return success only when exactly one row was transitioned.
- Concurrent consumers must have exactly one winner.
- Replays, expired grants, role revocation, membership revocation, path/content changes, and tenant substitution must return denial.

A conditional UPDATE with status = APPROVED, consumed_at IS NULL, expires_at > clock_timestamp(), and exact binding predicates is the minimum. Membership and role checks must be part of the same transaction/function, not a separate application-side precheck that can race.

Any SECURITY DEFINER function used for this operation must have a fixed safe search_path, fully qualified object references, minimal EXECUTE grants, no dynamic SQL from caller input, and a narrowly constrained auth.uid()-bound executor. Revoke default PUBLIC/anon execution. Do not grant a generic arbitrary grant-consumption function to clients. Test actual Postgres concurrency and role-revocation races before production use.

## 5. RLS and API exposure

- Tenant tables must have explicit RLS enabled and reviewed policies; automatic RLS enablement is not a substitute for policies.
- Policies must derive the user from auth.uid() and require active membership in the exact organization/workspace. Do not use client-supplied user IDs or role claims as authority.
- Keep grant and execution-request mutation paths server-controlled. Ordinary clients must not be able to insert an APPROVED grant, change requester/executor/approver fields, set consumed_at, or bypass the decision workflow.
- Prefer a private schema excluded from PostgREST exposed schemas for server-owned records. If a server API needs database access, use a deliberately scoped server-side database boundary; do not solve access by placing the service-role key in the browser or disabling RLS.
- If any narrowly scoped SECURITY DEFINER RPC is required, expose only the exact operation required, enforce auth.uid() and tenant membership inside it, and test grants/ACLs. No generic table-write RPC.
- The public.rls_auto_enable() event trigger observed in the connected project only enables RLS on newly created public tables; it does not create tenant policies and does not protect private-schema tables. Review it separately as recorded in the Supabase project security baseline.

## 6. Auth and application integration sequence

1. Reconcile this model with the existing HAPPY architecture and any legacy tenant IDs. Produce a read-only inventory/mapping before migration.
2. Adopt the auth-foundation branch's verified subject pattern (auth.getClaims() and validated sub) only after its route/session changes and dependency versions are reviewed. Never authorize from user_metadata.
3. Implement a server-only membership provider for the canonical resolver. It must return records from the schema above and fail closed on missing/inactive/mismatched rows.
4. Persist execution requests before approvals; derive requester and executor from that durable row during resume/recovery.
5. Implement approval create/approve/revoke decisions with approver identity derived from the verified server session and current membership.
6. Implement the named-executor grant store and database-atomic consume function.
7. Compose FILE READ authorization separately from mutation grants. READ must have its own scoped path policy; a mutation grant must never authorize READ.
8. Inject both authorizers only in the authenticated server composition root. Keep all other constructors/default paths fail-closed.
9. Add disposable-Postgres integration tests for RLS, tenant mismatch, revoked membership/role, expiry, tampering, replay, and concurrent single-winner consumption.
10. Only after independent security review and explicit owner approval should a reviewed migration be applied to a non-production environment, then promoted through the normal migration/release process.

## 7. Explicit non-goals and blockers

- This document does not define the complete HAPPY organization/business/department/branch hierarchy or replace business-domain models.
- It does not decide data migration from any existing local or remote IDs.
- It does not add SQL migrations, database functions, Supabase adapters, routes, or runtime composition.
- It does not activate FILE READ or FILE mutations.
- The connected Supabase project currently has no confirmed HAPPY application tables or migration history. Schema names, constraints, and roles must be verified against the target project before implementation.
- No production write, schema change, Auth setting change, merge, or deployment is authorized by this design document.

## 8. Acceptance checklist

- [ ] Legacy tenant IDs inventoried and mapping approved.
- [ ] Organization/workspace/member schema and role matrix reviewed.
- [ ] RLS policies tested as anon, authenticated, and server-side principals.
- [ ] No client path can create or modify an APPROVED grant.
- [ ] Requester, approver, executor are distinct and immutable.
- [ ] Named executor and current approver role are revalidated at consume time.
- [ ] Atomic consume proves exactly one winner under real Postgres concurrency.
- [ ] FILE READ uses an independent scoped read authorizer.
- [ ] No service-role credential reaches client bundles.
- [ ] Default-deny behavior holds for missing providers, store errors, and incomplete composition.
