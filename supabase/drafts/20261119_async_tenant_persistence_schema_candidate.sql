-- DESIGN-ONLY schema candidate for HAPPY async tenant persistence.
-- DO NOT APPLY to a connected/shared/production Supabase project.
--
-- Depends on the tenant identity tables defined by the separate
-- file-mutation candidate:
--   private.organizations
--   private.workspaces
--   private.organization_memberships
--   private.workspace_memberships
--
-- This draft intentionally does not create or mutate those identity tables.
-- Reconcile ownership, schema grants, migration order, and RLS before use.
--
-- Storage contract:
--   key = organization_id + workspace_id + user_id + entity_type + id
--   every read/write is constrained by the complete key scope
--   create starts at version 1
--   update/delete are compare-and-swap on expected version
--   transaction callbacks use one real PostgreSQL transaction/connection
--
-- This table is the durable representation of AsyncTenantPersistenceAdapter.
-- It is not yet wired to a production adapter.

create table public.happy_tenant_records (
  organization_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null references auth.users(id) on delete restrict,
  entity_type text not null check (entity_type in (
    'USER',
    'WORKSPACE',
    'PROJECT',
    'COMMAND',
    'MISSION',
    'TASK',
    'EXECUTION',
    'VERIFICATION',
    'VERIFICATION_REQUEST',
    'EVIDENCE',
    'MEMORY',
    'APPROVAL',
    'AUDIT_EVENT'
  )),
  record_id text not null check (length(btrim(record_id)) > 0),
  version bigint not null default 1 check (version >= 1),
  data jsonb not null check (jsonb_typeof(data) = 'object'),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),

  constraint happy_tenant_records_pk primary key (
    organization_id,
    workspace_id,
    user_id,
    entity_type,
    record_id
  ),
  constraint happy_tenant_records_workspace_fk
    foreign key (organization_id, workspace_id)
    references private.workspaces(organization_id, workspace_id)
    on delete restrict,
  constraint happy_tenant_records_created_updated_check
    check (updated_at >= created_at)
);

comment on table public.happy_tenant_records is
  'HAPPY tenant-scoped async records; every access must bind organization, workspace, authenticated user, entity type, and record ID.';
comment on column public.happy_tenant_records.version is
  'Monotonic optimistic concurrency token. Updates/deletes must match the caller expected version atomically.';
comment on column public.happy_tenant_records.data is
  'Entity payload JSON object. Tenant identity and concurrency metadata are stored in typed columns, never trusted from this payload.';

-- Tenant-first indexes. The primary key supports exact get/create/update/delete.
-- This secondary index supports entity-scoped list ordering without a global scan.
create index happy_tenant_records_entity_updated_idx
  on public.happy_tenant_records (
    organization_id,
    workspace_id,
    user_id,
    entity_type,
    updated_at desc,
    record_id
  );

create index happy_tenant_records_scope_updated_idx
  on public.happy_tenant_records (
    organization_id,
    workspace_id,
    user_id,
    updated_at desc
  );

-- The policy helper derives the principal only from auth.uid(). Tenant IDs
-- are selectors, never proof of membership. It reads the canonical membership
-- tables created by the separate identity-schema candidate.
--
-- Deployment prerequisite: own this function with a narrowly privileged,
-- non-login database role that can read these four private tables and whose
-- RLS behavior has been explicitly verified. Do not use service_role as a
-- substitute for an authenticated user or as a general RLS bypass.
create or replace function public.happy_has_active_tenant_scope(
  p_organization_id uuid,
  p_workspace_id uuid
)
returns boolean
language sql
stable
security definer
set search_path = pg_catalog
as $scope$
  select exists (
    select 1
      from private.organizations o
      join private.workspaces w
        on w.organization_id = o.organization_id
      join private.organization_memberships om
        on om.organization_id = o.organization_id
      join private.workspace_memberships wm
        on wm.organization_id = w.organization_id
       and wm.workspace_id = w.workspace_id
       and wm.user_id = om.user_id
     where o.organization_id = p_organization_id
       and w.workspace_id = p_workspace_id
       and om.user_id = auth.uid()
       and o.status = 'ACTIVE'
       and w.status = 'ACTIVE'
       and om.status = 'ACTIVE'
       and wm.status = 'ACTIVE'
  );
$scope$;

alter table public.happy_tenant_records enable row level security;

create policy happy_tenant_records_select_own_active_scope
  on public.happy_tenant_records
  for select
  to authenticated
  using (
    user_id = auth.uid()
    and public.happy_has_active_tenant_scope(organization_id, workspace_id)
  );

create policy happy_tenant_records_insert_own_active_scope
  on public.happy_tenant_records
  for insert
  to authenticated
  with check (
    user_id = auth.uid()
    and version = 1
    and public.happy_has_active_tenant_scope(organization_id, workspace_id)
  );

create policy happy_tenant_records_update_own_active_scope
  on public.happy_tenant_records
  for update
  to authenticated
  using (
    user_id = auth.uid()
    and public.happy_has_active_tenant_scope(organization_id, workspace_id)
  )
  with check (
    user_id = auth.uid()
    and public.happy_has_active_tenant_scope(organization_id, workspace_id)
  );

create policy happy_tenant_records_delete_own_active_scope
  on public.happy_tenant_records
  for delete
  to authenticated
  using (
    user_id = auth.uid()
    and public.happy_has_active_tenant_scope(organization_id, workspace_id)
  );

revoke all on function public.happy_has_active_tenant_scope(uuid, uuid)
  from public, anon;
grant execute on function public.happy_has_active_tenant_scope(uuid, uuid)
  to authenticated;

revoke all on public.happy_tenant_records from public, anon;
grant select, insert on public.happy_tenant_records to authenticated;
revoke update, delete on public.happy_tenant_records from authenticated;

-- REQUIRED ADAPTER SQL SEMANTICS (implement in a reviewed server adapter):
--
-- GET:
--   WHERE organization_id=$org AND workspace_id=$workspace
--     AND user_id=auth.uid() AND entity_type=$type AND record_id=$id
--
-- LIST:
--   same complete scope, optional entity_type, ORDER BY updated_at DESC,
--   bounded LIMIT. Never load a global table and filter in application memory.
--
-- CREATE:
--   INSERT with version=1; map unique_violation to RECORD_ALREADY_EXISTS.
--
-- UPDATE / DELETE:
--   Direct UPDATE and DELETE grants are intentionally withheld from authenticated.
--   Do not expose unrestricted table writes: RLS alone cannot enforce the
--   adapter's expected-version compare-and-swap contract. Implement narrowly
--   reviewed user-JWT RPCs (or an equivalent trusted transaction boundary)
--   that derive user_id from auth.uid(), bind the full scope/key, and perform:
--     UPDATE ... SET data=$data, version=version+1,
--         updated_at=clock_timestamp()
--      WHERE organization_id=$org AND workspace_id=$workspace
--        AND user_id=auth.uid() AND entity_type=$type AND record_id=$id
--        AND version=$expected_version RETURNING ...;
--     DELETE ... WHERE the same full scope/key AND version=$expected_version
--       RETURNING record_id;
--   If no row returns, use a scope-bound existence check to distinguish
--   RECORD_NOT_FOUND from VERSION_CONFLICT. Never widen that diagnostic query.
--   No such RPCs are implemented by this candidate, so the production adapter
--   remains NOT_CONNECTED until that security review and implementation exist.
--
-- TRANSACTION:
--   callback operations must share one PostgreSQL transaction. Independent
--   PostgREST HTTP requests do not satisfy AsyncTenantPersistenceAdapter.transaction.
--   A server-side PostgreSQL connection/transaction or a reviewed transactional
--   RPC is required. Roll back all writes if the callback fails.
--
-- SECURITY / INTEGRATION GATES BEFORE THIS CAN BECOME A MIGRATION:
-- 1. Apply/review canonical organization/workspace/membership schema first.
-- 2. Resolve the existing private-schema privilege model: the separate FILE
--    approval candidate revokes private schema usage from authenticated and
--    grants it to service_role. This helper therefore needs a deliberately
--    reviewed owner/privilege design; do not assume it can read those tables.
-- 3. Verify function owner, BYPASSRLS, FORCE ROW LEVEL SECURITY behavior,
--    table grants, function grants, and auth.uid() with real user JWTs.
-- 4. Implement reviewed CAS update/delete RPCs before enabling those writes;
--    direct authenticated UPDATE/DELETE is deliberately revoked. Test cross-user,
--    cross-workspace, suspended/revoked membership, duplicate create, stale CAS
--    update/delete, concurrent writers, and rollback using
--    disposable PostgreSQL plus actual Supabase JWT integration.
-- 5. Decide retention, audit/event coupling, payload size limits, and entity
--    lifecycle constraints. This generic record table does not replace typed
--    relational constraints for approval/execution lifecycle tables.
-- 6. No service-role request may impersonate a user by passing user_id.
-- 7. No live migration or data write is authorized by this draft.
