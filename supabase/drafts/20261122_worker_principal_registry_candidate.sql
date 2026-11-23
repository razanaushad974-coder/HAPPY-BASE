-- HAPPY dedicated PostgreSQL worker principal registry (DESIGN DRAFT ONLY)
-- Date: 2026-11-22
--
-- This file is intentionally NOT a migration and must not be applied.
-- It establishes the database-side identity lookup primitive for a future
-- dedicated-login worker broker. It does not grant RPC execution or table access.
--
-- Trust model:
--   * session_user is the PostgreSQL-authenticated LOGIN role.
--   * No worker ID, role name, tenant, or capability supplied by an RPC caller
--     is treated as proof of identity.
--   * A trusted operator provisions a dedicated LOGIN role out-of-band and
--     inserts the matching registry row through an administrative path.
--   * The role must not be a superuser, role creator, database creator,
--     replication role, or RLS-bypass role.
--   * The helper returns the immutable DB-side worker registration. Each
--     worker operation must still check a worker-to-tenant grant, canonical
--     tenant membership, founder approval, task binding, and current lease
--     inside the same transaction before mutating state.
--
-- No CREATE ROLE, passwords, grants to worker logins, or production changes
-- are included here. Hosted Supabase must be tested for preserving session_user
-- before this design can be considered deployable.

begin;

create or replace function private.happy_worker_capabilities_valid(p_capabilities text[])
returns boolean
language sql
immutable
set search_path = pg_catalog
as $capability_check$
  select p_capabilities is not null
     and cardinality(p_capabilities) > 0
     and array_position(p_capabilities, null) is null
     and p_capabilities <@ array['CODE','FILE','API','BROWSER','SHELL','DATABASE','AI','DEPLOYMENT','PUBLISH','AUTOMATION','DEPLOY','CONTROL','VERIFY']::text[]
     and cardinality(p_capabilities) = (
       select count(distinct capability)::integer
         from unnest(p_capabilities) as capability
     );
$capability_check$;

create table if not exists private.happy_worker_principal_registry (
  worker_principal_id uuid primary key,
  db_login_role text not null unique
    check (db_login_role ~ '^happy_worker_[a-z0-9_]{1,48}$'),
  issuer text not null check (length(btrim(issuer)) > 0),
  subject text not null check (length(btrim(subject)) > 0),
  audience text not null check (length(btrim(audience)) > 0),
  environment text not null check (length(btrim(environment)) > 0),
  capabilities text[] not null
    check (private.happy_worker_capabilities_valid(capabilities)),
  enabled boolean not null default false,
  activated_at timestamptz,
  revoked_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint happy_worker_registry_activation_consistency
    check (not enabled or (activated_at is not null and revoked_at is null))
);

create table if not exists private.happy_worker_tenant_grants (
  worker_principal_id uuid not null
    references private.happy_worker_principal_registry(worker_principal_id)
    on delete restrict,
  organization_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null references auth.users(id) on delete restrict,
  capabilities text[] not null
    check (private.happy_worker_capabilities_valid(capabilities)),
  enabled boolean not null default false,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  primary key (worker_principal_id, organization_id, workspace_id, user_id),
  foreign key (organization_id, workspace_id)
    references private.workspaces(organization_id, workspace_id)
    on delete restrict
);

create index if not exists happy_worker_tenant_grants_scope_idx
  on private.happy_worker_tenant_grants
    (organization_id, workspace_id, user_id, worker_principal_id)
  where enabled = true;

revoke all on private.happy_worker_principal_registry
  from public, anon, authenticated, service_role;
revoke all on private.happy_worker_tenant_grants
  from public, anon, authenticated, service_role;

comment on table private.happy_worker_principal_registry is
  'Operator-managed mapping from a dedicated PostgreSQL LOGIN role to a worker principal. No API-role access.';
comment on table private.happy_worker_tenant_grants is
  'Operator-managed worker tenant allowlist. Every operation must additionally recheck canonical membership and approval transactionally.';

-- Keep the registry and canonical tenant tables behind RLS as well as schema
-- and table grants. A dedicated NOLOGIN function-owner role receives SELECT
-- policies only; it is not a BYPASSRLS role and has no general table writes.
alter table private.happy_worker_principal_registry enable row level security;
alter table private.happy_worker_tenant_grants enable row level security;
alter table private.organizations enable row level security;
alter table private.workspaces enable row level security;
alter table private.organization_memberships enable row level security;
alter table private.workspace_memberships enable row level security;

drop policy if exists happy_worker_registry_owner_read
  on private.happy_worker_principal_registry;
create policy happy_worker_registry_owner_read
  on private.happy_worker_principal_registry
  for select to happy_worker_registry_owner using (true);

drop policy if exists happy_worker_tenant_grants_owner_read
  on private.happy_worker_tenant_grants;
create policy happy_worker_tenant_grants_owner_read
  on private.happy_worker_tenant_grants
  for select to happy_worker_registry_owner using (true);

drop policy if exists happy_worker_organizations_owner_read
  on private.organizations;
create policy happy_worker_organizations_owner_read
  on private.organizations
  for select to happy_worker_registry_owner using (true);

drop policy if exists happy_worker_workspaces_owner_read
  on private.workspaces;
create policy happy_worker_workspaces_owner_read
  on private.workspaces
  for select to happy_worker_registry_owner using (true);

drop policy if exists happy_worker_org_memberships_owner_read
  on private.organization_memberships;
create policy happy_worker_org_memberships_owner_read
  on private.organization_memberships
  for select to happy_worker_registry_owner using (true);

drop policy if exists happy_worker_workspace_memberships_owner_read
  on private.workspace_memberships;
create policy happy_worker_workspace_memberships_owner_read
  on private.workspace_memberships
  for select to happy_worker_registry_owner using (true);

-- PostgreSQL 17.12 probe result:
-- SELECT ... FOR SHARE requires an UPDATE SQL privilege and an UPDATE RLS
-- policy whose USING expression admits the row. WITH CHECK is evaluated for
-- attempted mutations, so USING (true) WITH CHECK (false) permits the row lock
-- while rejecting every UPDATE. The lock-only policy is intentionally narrow:
-- never use WITH CHECK (true) for this owner.
drop policy if exists happy_worker_registry_owner_lock on private.happy_worker_principal_registry;
create policy happy_worker_registry_owner_lock
  on private.happy_worker_principal_registry
  for update to happy_worker_registry_owner
  using (true)
  with check (false);

drop policy if exists happy_worker_tenant_grants_owner_lock on private.happy_worker_tenant_grants;
create policy happy_worker_tenant_grants_owner_lock
  on private.happy_worker_tenant_grants
  for update to happy_worker_registry_owner
  using (true)
  with check (false);

drop policy if exists happy_worker_organizations_owner_lock on private.organizations;
create policy happy_worker_organizations_owner_lock
  on private.organizations
  for update to happy_worker_registry_owner
  using (true)
  with check (false);

drop policy if exists happy_worker_workspaces_owner_lock on private.workspaces;
create policy happy_worker_workspaces_owner_lock
  on private.workspaces
  for update to happy_worker_registry_owner
  using (true)
  with check (false);

drop policy if exists happy_worker_org_memberships_owner_lock on private.organization_memberships;
create policy happy_worker_org_memberships_owner_lock
  on private.organization_memberships
  for update to happy_worker_registry_owner
  using (true)
  with check (false);

drop policy if exists happy_worker_workspace_memberships_owner_lock on private.workspace_memberships;
create policy happy_worker_workspace_memberships_owner_lock
  on private.workspace_memberships
  for update to happy_worker_registry_owner
  using (true)
  with check (false);

create or replace function private.happy_require_worker_principal(
  p_required_capability text
)
returns table (
  worker_principal_id uuid,
  issuer text,
  subject text,
  audience text,
  environment text,
  capabilities text[]
)
language plpgsql
security definer
set search_path = pg_catalog
as $worker_identity$
declare
  v_login_role text := session_user::text;
  v_role record;
begin
  if p_required_capability is null
     or p_required_capability not in ('CODE','FILE','API','BROWSER','SHELL','DATABASE','AI','DEPLOYMENT','PUBLISH','AUTOMATION','DEPLOY','CONTROL','VERIFY') then
    raise exception 'INVALID_WORKER_CAPABILITY' using errcode = '22023';
  end if;

  select r.rolcanlogin, r.rolsuper, r.rolcreaterole, r.rolcreatedb,
         r.rolreplication, r.rolbypassrls
    into v_role
    from pg_catalog.pg_roles r
   where r.rolname = v_login_role;

  if not found
     or v_role.rolcanlogin is distinct from true
     or v_role.rolsuper is distinct from false
     or v_role.rolcreaterole is distinct from false
     or v_role.rolcreatedb is distinct from false
     or v_role.rolreplication is distinct from false
     or v_role.rolbypassrls is distinct from false then
    raise exception 'WORKER_DATABASE_LOGIN_ROLE_NOT_ALLOWED' using errcode = '42501';
  end if;

  return query
    select p.worker_principal_id, p.issuer, p.subject, p.audience,
           p.environment, p.capabilities
      from private.happy_worker_principal_registry p
     where p.db_login_role = v_login_role
       and p.enabled = true
       and p.activated_at is not null
       and p.revoked_at is null
       and p.capabilities @> array[p_required_capability]::text[]
     for share;

  if not found then
    raise exception 'WORKER_PRINCIPAL_NOT_REGISTERED_OR_CAPABILITY_DENIED'
      using errcode = '42501';
  end if;
end;
$worker_identity$;

revoke all on function private.happy_require_worker_principal(text)
  from public, anon, authenticated, service_role;

-- Resolve a caller-selected tenant/user scope only after deriving the worker
-- principal from session_user and locking the current registry/grant/membership
-- rows. The user ID is a selector, not proof: the live worker grant and active
-- canonical memberships are rechecked on every operation.
create or replace function private.happy_require_worker_tenant_scope(
  p_worker_principal_id uuid,
  p_organization_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
  p_required_capability text
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $worker_scope$
declare
  v_principal_id uuid;
  v_user_id uuid;
  v_found boolean;
begin
  if p_worker_principal_id is null
     or p_organization_id is null
     or p_workspace_id is null
     or p_user_id is null
     or p_required_capability is null
     or p_required_capability not in ('CODE','FILE','API','BROWSER','SHELL','DATABASE','AI','DEPLOYMENT','PUBLISH','AUTOMATION','DEPLOY','CONTROL','VERIFY') then
    raise exception 'INVALID_WORKER_TENANT_SCOPE' using errcode = '22023';
  end if;

  select principal.worker_principal_id into v_principal_id
    from private.happy_require_worker_principal(p_required_capability) principal
   where principal.worker_principal_id = p_worker_principal_id;
  if not found then
    raise exception 'WORKER_PRINCIPAL_SCOPE_MISMATCH' using errcode = '42501';
  end if;

  -- The principal helper above locks the exact session_user-mapped registry
  -- row with FOR SHARE. Continue in a fixed order for the tenant grant and
  -- canonical organization/workspace membership rows.
  select g.user_id into v_user_id
    from private.happy_worker_tenant_grants g
   where g.worker_principal_id = v_principal_id
     and g.organization_id = p_organization_id
     and g.workspace_id = p_workspace_id
     and g.user_id = p_user_id
     and g.enabled = true
     and g.capabilities @> array[p_required_capability]::text[]
   for share;
  if not found then
    raise exception 'WORKER_TENANT_GRANT_DENIED' using errcode = '42501';
  end if;

  select true into v_found
    from private.organizations o
   where o.organization_id = p_organization_id
     and o.status = 'ACTIVE'
   for share;
  if not found then
    raise exception 'WORKER_TENANT_SCOPE_INACTIVE' using errcode = '42501';
  end if;

  select true into v_found
    from private.workspaces w
   where w.organization_id = p_organization_id
     and w.workspace_id = p_workspace_id
     and w.status = 'ACTIVE'
   for share;
  if not found then
    raise exception 'WORKER_TENANT_SCOPE_INACTIVE' using errcode = '42501';
  end if;

  select true into v_found
    from private.organization_memberships om
   where om.organization_id = p_organization_id
     and om.user_id = v_user_id
     and om.status = 'ACTIVE'
   for share;
  if not found then
    raise exception 'WORKER_TENANT_MEMBERSHIP_REVOKED' using errcode = '42501';
  end if;

  select true into v_found
    from private.workspace_memberships wm
   where wm.organization_id = p_organization_id
     and wm.workspace_id = p_workspace_id
     and wm.user_id = v_user_id
     and wm.status = 'ACTIVE'
   for share;
  if not found then
    raise exception 'WORKER_TENANT_MEMBERSHIP_REVOKED' using errcode = '42501';
  end if;

  return v_user_id;
end;
$worker_scope$;

revoke all on function private.happy_require_worker_tenant_scope(uuid,uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;

-- Intentionally no GRANT EXECUTE, no worker-role grants, and no public RPCs.
-- Future SECURITY DEFINER worker operations must call this helper and then
-- verify the matching row in happy_worker_tenant_grants plus the canonical
-- workspace membership and persisted founder approval, task graph, and lease.
-- The helper is not itself a complete authorization decision.

commit;
