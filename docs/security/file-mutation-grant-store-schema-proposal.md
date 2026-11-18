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
- Generate the migration via `supabase migration new`, review it, run Supabase security advisors and RLS tests, then request explicit approval before applying anywhere.
