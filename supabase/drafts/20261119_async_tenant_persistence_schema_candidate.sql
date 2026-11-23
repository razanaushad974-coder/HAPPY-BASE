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
       and om.user_id = private.happy_current_authenticated_user_id()
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

revoke all on public.happy_tenant_records from public, anon, service_role;
grant select on public.happy_tenant_records to authenticated;
revoke insert, update, delete on public.happy_tenant_records from authenticated;

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
--   Call public.happy_create_tenant_record(...); it derives auth.uid(), locks
--   active tenant/membership rows, inserts version 1, and maps unique_violation
--   to RECORD_ALREADY_EXISTS. Direct authenticated INSERT is revoked.
--
-- UPDATE / DELETE:
--   Use the CAS RPCs defined below; they derive user_id from auth.uid(), lock
--   the active tenant/membership rows, bind the full scope/key, and perform:
--     UPDATE ... SET data=$data, version=version+1,
--         updated_at=clock_timestamp()
--      WHERE organization_id=$org AND workspace_id=$workspace
--        AND user_id=auth.uid() AND entity_type=$type AND record_id=$id
--        AND version=$expected_version RETURNING ...;
--     DELETE ... WHERE the same full scope/key AND version=$expected_version
--       RETURNING record_id;
--   If no row returns, use a scope-bound existence check to distinguish
--   RECORD_NOT_FOUND from VERSION_CONFLICT. Never widen that diagnostic query.
--   The RPC candidates are defined below. They are not deployable until the
--   function-owner, role grants, membership-table access, and real-JWT tests
--   have been reviewed and verified. The production adapter remains NOT_CONNECTED.
--
-- Serialize writes against tenant membership/status revocation. Lock order is
-- organization -> workspace -> organization membership -> workspace membership.
-- A concurrent status UPDATE either commits before this check (and is denied)
-- or waits until the authorized write transaction completes.
create or replace function public.happy_lock_active_tenant_scope(
  p_organization_id uuid,
  p_workspace_id uuid
)
returns boolean
language plpgsql
volatile
security definer
set search_path = pg_catalog
as $lock_scope$
declare
  v_actor uuid;
begin
  v_actor := private.happy_current_authenticated_user_id();
  if v_actor is null then return false; end if;

  perform 1
    from private.organizations o
   where o.organization_id = p_organization_id
     and o.status = 'ACTIVE'
   for share;
  if not found then return false; end if;

  perform 1
    from private.workspaces w
   where w.organization_id = p_organization_id
     and w.workspace_id = p_workspace_id
     and w.status = 'ACTIVE'
   for share;
  if not found then return false; end if;

  perform 1
    from private.organization_memberships om
   where om.organization_id = p_organization_id
     and om.user_id = v_actor
     and om.status = 'ACTIVE'
   for share;
  if not found then return false; end if;

  perform 1
    from private.workspace_memberships wm
   where wm.organization_id = p_organization_id
     and wm.workspace_id = p_workspace_id
     and wm.user_id = v_actor
     and wm.status = 'ACTIVE'
   for share;
  if not found then return false; end if;

  return true;
end;
$lock_scope$;

revoke all on function public.happy_lock_active_tenant_scope(uuid, uuid)
  from public, anon, authenticated, service_role;

-- Create is a SECURITY DEFINER RPC so active membership rows are locked before
-- insert. Authenticated clients cannot bypass that check with direct INSERT.
create or replace function public.happy_create_tenant_record(
  p_organization_id uuid,
  p_workspace_id uuid,
  p_entity_type text,
  p_record_id text,
  p_data jsonb
)
returns public.happy_tenant_records
language plpgsql
security definer
set search_path = pg_catalog
as $create$
declare
  v_actor uuid;
  v_record public.happy_tenant_records%rowtype;
begin
  v_actor := auth.uid();
  if v_actor is null
     or not public.happy_lock_active_tenant_scope(p_organization_id, p_workspace_id) then
    raise exception 'TENANT_SCOPE_DENIED' using errcode = '42501';
  end if;

  if p_data is null or jsonb_typeof(p_data) <> 'object'
     or p_record_id is null or length(btrim(p_record_id)) = 0 then
    raise exception 'INVALID_RECORD_INPUT' using errcode = '22023';
  end if;

  insert into public.happy_tenant_records
    (organization_id, workspace_id, user_id, entity_type, record_id, version, data)
  values
    (p_organization_id, p_workspace_id, v_actor, p_entity_type, p_record_id, 1, p_data)
  returning * into v_record;

  return v_record;
end;
$create$;

revoke all on function public.happy_create_tenant_record(uuid, uuid, text, text, jsonb)
  from public, anon, service_role;
grant execute on function public.happy_create_tenant_record(uuid, uuid, text, text, jsonb)
  to authenticated;

-- Atomic compare-and-swap write RPCs. They derive the principal from auth.uid(),
-- never accept user_id as a parameter, and are the only authenticated update/delete
-- surface. Their owner/privilege model is a deployment gate documented below.
create or replace function public.happy_update_tenant_record(
  p_organization_id uuid,
  p_workspace_id uuid,
  p_entity_type text,
  p_record_id text,
  p_expected_version bigint,
  p_data jsonb
)
returns public.happy_tenant_records
language plpgsql
security definer
set search_path = pg_catalog
as $update$
declare
  v_actor uuid;
  v_record public.happy_tenant_records%rowtype;
  v_exists boolean;
begin
  v_actor := auth.uid();
  if v_actor is null
     or not public.happy_lock_active_tenant_scope(p_organization_id, p_workspace_id) then
    raise exception 'TENANT_SCOPE_DENIED' using errcode = '42501';
  end if;

  if p_expected_version is null or p_expected_version < 1
     or p_data is null or jsonb_typeof(p_data) <> 'object'
     or p_record_id is null or length(btrim(p_record_id)) = 0 then
    raise exception 'INVALID_RECORD_INPUT' using errcode = '22023';
  end if;

  update public.happy_tenant_records as r
     set data = p_data,
         version = r.version + 1,
         updated_at = clock_timestamp()
   where r.organization_id = p_organization_id
     and r.workspace_id = p_workspace_id
     and r.user_id = v_actor
     and r.entity_type = p_entity_type
     and r.record_id = p_record_id
     and r.version = p_expected_version
   returning r.* into v_record;

  if found then
    return v_record;
  end if;

  select exists (
    select 1
      from public.happy_tenant_records as r
     where r.organization_id = p_organization_id
       and r.workspace_id = p_workspace_id
       and r.user_id = v_actor
       and r.entity_type = p_entity_type
       and r.record_id = p_record_id
  ) into v_exists;

  if v_exists then
    raise exception 'VERSION_CONFLICT' using errcode = '40001';
  end if;

  raise exception 'RECORD_NOT_FOUND' using errcode = 'P0002';
end;
$update$;

create or replace function public.happy_delete_tenant_record(
  p_organization_id uuid,
  p_workspace_id uuid,
  p_entity_type text,
  p_record_id text,
  p_expected_version bigint
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $delete$
declare
  v_actor uuid;
  v_deleted boolean;
  v_exists boolean;
begin
  v_actor := auth.uid();
  if v_actor is null
     or not public.happy_lock_active_tenant_scope(p_organization_id, p_workspace_id) then
    raise exception 'TENANT_SCOPE_DENIED' using errcode = '42501';
  end if;

  if p_expected_version is null or p_expected_version < 1
     or p_record_id is null or length(btrim(p_record_id)) = 0 then
    raise exception 'INVALID_RECORD_INPUT' using errcode = '22023';
  end if;

  delete from public.happy_tenant_records as r
   where r.organization_id = p_organization_id
     and r.workspace_id = p_workspace_id
     and r.user_id = v_actor
     and r.entity_type = p_entity_type
     and r.record_id = p_record_id
     and r.version = p_expected_version
  returning true into v_deleted;

  if found then
    return true;
  end if;

  select exists (
    select 1
      from public.happy_tenant_records as r
     where r.organization_id = p_organization_id
       and r.workspace_id = p_workspace_id
       and r.user_id = v_actor
       and r.entity_type = p_entity_type
       and r.record_id = p_record_id
  ) into v_exists;

  if v_exists then
    raise exception 'VERSION_CONFLICT' using errcode = '40001';
  end if;

  return false;
end;
$delete$;

revoke all on function public.happy_update_tenant_record(uuid, uuid, text, text, bigint, jsonb)
  from public, anon, service_role;
revoke all on function public.happy_delete_tenant_record(uuid, uuid, text, text, bigint)
  from public, anon, service_role;
grant execute on function public.happy_update_tenant_record(uuid, uuid, text, text, bigint, jsonb)
  to authenticated;
grant execute on function public.happy_delete_tenant_record(uuid, uuid, text, text, bigint)
  to authenticated;

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
-- 3. Verify function owners, BYPASSRLS, FORCE ROW LEVEL SECURITY behavior,
--    table grants, function grants, and auth.uid() with real user JWTs.
-- 4. Direct authenticated INSERT/UPDATE/DELETE is deliberately revoked; create
--    and CAS RPCs lock the active tenant/membership rows before writing. Test cross-user,
--    cross-workspace, suspended/revoked membership, duplicate create, stale CAS
--    update/delete, concurrent writers, and rollback using disposable PostgreSQL
--    plus actual Supabase JWT integration.
-- 5. Decide retention, audit/event coupling, payload size limits, and entity
--    lifecycle constraints. This generic record table does not replace typed
--    relational constraints for approval/execution lifecycle tables.
-- 6. No service-role request may impersonate a user by passing user_id.
-- 7. No live migration or data write is authorized by this draft.
