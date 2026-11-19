# Durable FILE mutation grant store — schema proposal

**Status:** design-only; not applied to any Supabase project.

## Discovery performed

- The connected Supabase project is `razanaushad974PANDA` (`hsuxeebljhjwyxeuztzz`), PostgreSQL 17.6.
- Read-only table discovery returned no tables in `public` and no migration history rows for this project.
- The PR #8 base branch `security/file-mutation-authorizer` does not contain the candidate's Supabase runtime/session composition root or tenant resolver.
- A separate branch, `happy/supabase-auth-tenant-foundation`, does contain a cookie-based server client and `getVerifiedIdentity()` based on Supabase `auth.getClaims()`. It does **not** contain a canonical organization/workspace membership resolver, durable tenant schema, grant store, or runtime composition wiring.
- That auth-foundation branch is **diverged** from `security/file-mutation-authorizer` (22 commits ahead, 8 behind at inspection). It must not be merged/rebased into PR #8 blindly; its app-route and package changes need a separate conflict/security review first.
- Therefore this proposal deliberately does not assume existing `organizations`, `workspaces`, or `workspace_members` FK names/types. Tenant IDs are stored as text until the canonical schema is reconciled.
- No SQL was executed against the project. No migration was applied.

## Identity semantics and current limitation

The current verifier deliberately requires the authenticated execution actor to be the same user recorded as the grant approver. It checks that this actor is currently a member of the organization/workspace and still holds the required role at consumption time. This is a conservative, fail-closed policy for this contract.

**It does not yet support a distinct approver approving on behalf of a requester/agent that later executes under a different authenticated identity.** Do not weaken the approver equality check or trust an approver ID supplied by the execution request to enable that workflow. Supporting separate identities requires an explicit trusted identity-resolution design: the execution session must establish the executor, the persisted grant must establish the approver, and a server-side membership/role resolver must independently revalidate the approver in the same tenant at consumption time. Tests must cover executor/approver separation, revoked approver membership, revoked approver role, and cross-tenant identity substitution before that mode is enabled.

Until that design is implemented, only same-actor execution is supported by this authorizer; other identity arrangements must remain blocked.

## Storage boundary

Use a non-exposed `private` schema. Do not add this table to `public` or expose it through the Data API. The connected project currently reports no public tables, and Supabase's 2026 Data API default no longer automatically exposes newly created public tables; this design avoids depending on Data API exposure.

The grant row is server-owned. The client must never be able to create, approve, revoke, or consume a grant directly. Server code must use a server-only Supabase client with a secret/service-role credential; never place that credential in a `NEXT_PUBLIC_*` variable or browser bundle.

## Proposed migration SQL

The SQL below is a review artifact, **not an applied migration**. Before turning it into a migration, reconcile the tenant key types and FK targets against the canonical HAPPY schema and generate the migration with the Supabase CLI.

```sql
create schema if not exists private;

create table private.file_mutation_approval_grants (
  grant_id uuid primary key default gen_random_uuid(),
  request_id text not null,
  task_id text not null,
  mission_id text not null,
  requester_user_id uuid not null references auth.users(id) on delete restrict,
  approver_user_id uuid not null references auth.users(id) on delete restrict,
  organization_id text not null,
  workspace_id text not null,
  target_entity_type text not null default 'FILE'
    check (target_entity_type = 'FILE'),
  target_entity_id text not null,
  operation text not null
    check (operation in ('CREATE','MODIFY','COPY','MOVE','RENAME','DELETE')),
  source_path text not null,
  destination_path text,
  input_digest text not null
    check (input_digest ~ '^[0-9a-f]{64}$'),
  required_role text not null
    check (required_role in ('FOUNDER','ADMIN')),
  status text not null default 'PENDING'
    check (status in ('PENDING','APPROVED','REJECTED','REVOKED','EXPIRED','CONSUMED')),
  expires_at timestamptz not null,
  decided_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  constraint file_mutation_grant_no_self_approval check (requester_user_id <> approver_user_id),
  constraint file_mutation_grant_decision_consistency check (
    (status = 'PENDING' and decided_at is null)
    or (status in ('APPROVED','REJECTED','REVOKED','EXPIRED','CONSUMED') and decided_at is not null)
  ),
  constraint file_mutation_grant_consumption_consistency check (
    (status = 'CONSUMED' and consumed_at is not null)
    or (status <> 'CONSUMED' and consumed_at is null)
  ),
  constraint file_mutation_grant_expiry_after_creation check (expires_at > created_at)
);

create index file_mutation_grants_scope_request_idx
  on private.file_mutation_approval_grants
    (organization_id, workspace_id, request_id);

create index file_mutation_grants_scope_status_expiry_idx
  on private.file_mutation_approval_grants
    (organization_id, workspace_id, status, expires_at);

alter table private.file_mutation_approval_grants enable row level security;

-- No anon/authenticated policies and no direct client privileges.
revoke all on schema private from public, anon, authenticated;
revoke all on private.file_mutation_approval_grants from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update on private.file_mutation_approval_grants to service_role;
```

## Required atomic consume operation

The adapter must issue a single conditional UPDATE, never a read-then-write sequence. The WHERE clause must match all immutable binding fields and require `status = 'APPROVED'`, `consumed_at IS NULL`, and `expires_at > consumedAt`. Set `status = 'CONSUMED'`, `consumed_at = consumedAt`, and `updated_at = consumedAt`; request `RETURNING grant_id`. Exactly one returned row means success; zero rows means denied/replayed/raced/expired/mismatched. Postgres row locking makes concurrent consumers serialize and only one can transition the row.

Example shape (adapter binds every value as a parameter):

```sql
update private.file_mutation_approval_grants
set status = 'CONSUMED',
    consumed_at = $1,
    updated_at = $1
where grant_id = $2
  and organization_id = $3
  and workspace_id = $4
  and request_id = $5
  and task_id = $6
  and mission_id = $7
  and requester_user_id = $8
  and approver_user_id = $9
  and target_entity_type = 'FILE'
  and target_entity_id = $10
  and operation = $11
  and source_path = $12
  and destination_path is not distinct from $13
  and input_digest = $14
  and status = 'APPROVED'
  and consumed_at is null
  and expires_at > $1
returning grant_id;
```

The Supabase JS query builder must express this as one UPDATE request with all equality filters, `.is('consumed_at', null)`, `.gt('expires_at', consumedAt)`, and `.select('grant_id')`. Use a null-aware filter for destination path (or split the two cases without weakening other binding predicates).

## Decision workflow invariants

1. Grant creation stores immutable binding and starts at `PENDING`; only server-side approval decision service can set `APPROVED`.
2. The approver identity and tenant membership are derived from validated server session and canonical membership resolver, not JSON or user metadata.
3. Role is checked at decision time and again at consumption time.
4. Approval decision is a conditional update from PENDING only; no upsert.
5. Grant expiry is bounded by server policy; never accept an arbitrary client expiry.
6. Revocation changes only APPROVED to REVOKED; consumption and revocation race via conditional updates, so only one transition wins.
7. Persist a decision audit event (grant ID, actor, action, timestamp, reason code) without storing file content.
8. Service-role credentials stay server-side. Since service_role bypasses RLS, the adapter itself must enforce tenant filters on every lookup and mutation.

## Remaining blockers before implementation

- Confirm the connected Supabase project is the intended HAPPY environment; the inspected project has no public tables or migration records.
- Reconcile canonical organization/workspace ID types and membership table/role schema.
- Integrate the verified Supabase identity helper from the auth-foundation work only after reconciling its diverged branch with the selected execution/runtime branch; add a canonical tenant-membership resolver and server-only service client. `getVerifiedIdentity()` alone proves the user identity, not organization/workspace membership.
- Implement grant create/approve/revoke/get/consume store methods and test them against a disposable Supabase branch or local Postgres.
- The workspace executor now rejects existing symlink path components (including dangling final symlinks) and preflights batch changes before writing. This is still path-based validation followed by a separate filesystem operation; a time-of-check/time-of-use race remains possible if an attacker can mutate workspace directories concurrently. Do not treat this as race-free containment.
- A direct CODE-capability bypass was found: `CodeExecutionAdapter` instantiated `WorkspaceCodeExecutor` and called `execute()` without the FILE grant authorizer. The PR now removes that direct executor dependency and keeps CODE contract-only (`NOT_YET_CONNECTED`) until a server-owned execution service is composed. The existing CODE adapter regression harness expects this contract, but it has not yet been executed.
- The runtime call-site audit of execution/orchestration/workspace service files found `WorkspaceCodeExecutor` construction only in `FileExecutionAdapter` after the CODE adapter change. Keep low-level executor entry points internal to trusted server composition; repeat the call-site audit whenever new execution adapters or entry points are added.
- Generate the migration via `supabase migration new`, review it, run Supabase security advisors and RLS tests, then request explicit approval before applying anywhere.


## Named-executor implementation addendum (2026-11-19)

A separate core verifier now exists at `src/core/approval/named-executor-file-mutation-authorizer.ts`. It supports three independently sourced principals while remaining unwired from production composition:

- requester: supplied only by a context provider that must load the durable server-owned execution request;
- executor: current validated server session plus canonical active tenant membership;
- approver: persisted grant decision, independently reloaded as an active tenant member and rechecked for current FOUNDER/ADMIN role.

The first supported policy is named executor, not any-member delegation. The persisted grant must contain immutable `executor_user_id`. The schema proposal above is still design-only and must be amended before migration generation:

```sql
alter table private.file_mutation_approval_grants
  add column executor_user_id uuid not null references auth.users(id) on delete restrict;
```

For a new table, include `executor_user_id` at creation rather than applying the illustrative ALTER statement. The unique/candidate lookup index should include `organization_id, workspace_id, request_id, executor_user_id, status, expires_at`. The exact atomic consume predicate must include `requester_user_id`, `approver_user_id`, and `executor_user_id` plus every immutable operation binding. The approver must not be equated to the executor.

The new verifier's dependency contracts are not adapters: no Supabase membership provider, durable grant store, approval-decision workflow, or server composition root has been implemented. The legacy same-actor verifier remains unchanged. FILE mutation remains default-deny unless a trusted authorizer is explicitly composed. The core test harness validates distinct identities, named-executor mismatch, approver membership/role revocation, tenant mismatch, operation tampering, replay, concurrent single-winner consumption, and store failure; this fake-store test does not prove database atomicity.



## Canonical schema reconciliation v2 (2026-11-19) — authoritative addendum

This section supersedes the earlier same-actor text and the illustrative grant-table SQL above wherever they conflict. It remains a design artifact, not an applied migration.

### Verified starting point

Read-only inspection of connected project `hsuxeebljhjwyxeuztzz` (PostgreSQL 17.6) found Supabase-managed schemas/tables only; no HAPPY application tables and no project migration-history rows. The Auth schema contains `auth.users.id` as UUID, so user foreign keys can be typed UUID. There is no existing application organization/workspace key type to reuse. Therefore UUID tenant keys below are a proposed new contract, not a claim about an existing schema. Do not deploy this design until the target project and tenant lifecycle are confirmed.

### Canonical identity and tenant model

- `private.organizations`: UUID primary key, lifecycle status ACTIVE/SUSPENDED/ARCHIVED.
- `private.workspaces`: UUID primary key and organization_id FK; workspace belongs to exactly one organization.
- `private.organization_memberships`: unique (organization_id,user_id), status ACTIVE/SUSPENDED/REVOKED, role text governed by a server-side allowlist.
- `private.workspace_memberships`: unique (organization_id,workspace_id,user_id), same lifecycle statuses, role text governed by a server-side allowlist; composite FK ensures workspace belongs to that organization.
- `private.execution_requests`: durable server-owned request identity; immutable request/task/mission/tenant/requester/executor fields, state, and created_at. The current in-memory `ExecutionRequest` interface is not a durable source of requester identity and cannot replace this table.
- `private.file_mutation_approval_grants`: immutable operation binding plus requester, named executor, approver, required role, decision status/timestamps, expiry and one-time consumption.
- `private.file_mutation_approval_events`: append-only decision/revocation/consumption audit metadata; never file content or secret values.

Tenant IDs are UUID in this proposed schema; core TypeScript contracts currently type them as strings, which is compatible at runtime but requires strict UUID validation at the Supabase boundary.

### Identity and approval invariants

1. Requester is loaded from the durable execution request, not `ExecutionRequest` JSON or caller claims.
2. Executor is the current verified server session subject and must equal immutable `executor_user_id`.
3. Approver is loaded from the persisted grant decision and independently revalidated for active organization and workspace membership plus current FOUNDER/ADMIN role.
4. **Self-approval is prohibited:** `requester_user_id <> approver_user_id`. The database CHECK and verifier must both enforce this before membership lookup/consume. Requester may equal executor; approver must differ from requester.
5. The current code uses `FOUNDER | ADMIN` for grant roles. Canonical membership role values must be explicitly mapped to this approval policy; do not silently accept arbitrary non-empty roles.
6. Membership status must be checked on every sensitive request. JWT metadata and cached membership are not authorization sources.
7. Grant expiry is server bounded. A grant may transition PENDING -> APPROVED/REJECTED, APPROVED -> REVOKED/CONSUMED/EXPIRED; no terminal-state rewrite or re-approval.
8. Grant consumption and revocation are conditional single-row transitions. A race has exactly one winner.
9. Grant binding includes immutable executor_user_id, requester_user_id, approver_user_id, tenant, request/task/mission, FILE target, operation, source/destination path, and digest.
10. All application tables live in non-exposed `private`; no client grants or policies are added. Server-only access remains a separate trust boundary. A service-role client bypasses RLS, so every query still enforces exact tenant predicates and returned-row validation.

### Implementation gates

- Confirm the intended Supabase project/environment and UUID tenant-ID contract.
- Add a durable execution-request table before implementing the context provider.
- Define role allowlists and FOUNDER/ADMIN mapping before role resolver implementation.
- Implement membership store, approval workflow, grant store and append-only audit events as separate server-only adapters.
- Add real Postgres tests for RLS denial, cross-tenant lookup, revoked membership/role, no-self-approval, revoke-vs-consume race, and two concurrent consumers.
- Only then generate a reviewed migration with the Supabase CLI and request explicit approval before applying it.

No schema, SQL, RLS policy, migration, or database record was changed in this work.


## Server-side adapter implementation checkpoint (2026-11-19)

The branch now includes these source contracts/adapters:

- `src/core/tenant/supabase-private-tenant-stores.ts`
  - Reads organization and workspace memberships from the proposed private schema with exact user + tenant filters.
  - Implements named-executor grant lookup and one conditional UPDATE/RETURNING consumption request.
  - Includes requester, executor, approver, tenant, request/task/mission, target, operation, path, digest, expiry and unconsumed predicates in the consume request.
  - Uses null-aware destination-path filtering; database errors and zero-row results fail closed.
- `src/core/tenant/supabase-named-executor-context-provider.ts`
  - Loads requester and named executor from a durable `private.execution_requests` record.
  - Derives executor identity only through an injected verified-server-session provider.
  - Revalidates active organization and workspace membership before constructing the named-executor context.
  - Rechecks approver membership and delegates FOUNDER/ADMIN mapping to an explicit injected role policy; no role hierarchy is guessed.
- `src/tests/core/tenant/supabase-private-tenant-stores.test.ts`
  - Asserts the query contract uses a single UPDATE, exact principal/tenant/operation predicates, null-safe destination matching, expiry and one-time consumption.
  - Asserts membership lookups are constrained by verified user and tenant.
  - This is a fake query-builder contract test only; it does not prove PostgreSQL concurrency or actual Supabase schema compatibility.

### Explicit remaining gaps

- These adapters are not wired into a server-only composition root. Do not instantiate them with a browser client or unverified identity provider.
- The target private tables do not exist in the connected Supabase project. No migration has been generated or applied.
- `private.execution_requests` is now a required schema contract for the context provider. It must contain immutable `request_id, task_id, mission_id, requester_user_id, executor_user_id, organization_id, workspace_id` fields, with user foreign keys to `auth.users(id)` and tenant/workspace consistency constraints.
- The query-builder harness is not a substitute for a disposable PostgreSQL/Supabase integration test. Real tests must prove two concurrent consumers yield exactly one success and that revoke-vs-consume has exactly one winning state transition.
- Current Vercel PR checks returned deployment rate-limit failures ("retry in 24 hours") after the new commits; they are not code-test results. No new TypeScript, lint, security harness, or build validation is claimed for this adapter checkpoint.

No production schema, SQL, RLS, data, deployment, merge, or `main` change was made.
