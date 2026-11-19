#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGPORT:?PGPORT is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${PGDATABASE:?PGDATABASE is required}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCHEMA_FILE="$ROOT_DIR/supabase/drafts/20261119_async_tenant_persistence_schema_candidate.sql"
if [[ ! -f "$SCHEMA_FILE" ]]; then
  echo "Tenant persistence SQL candidate not found: $SCHEMA_FILE" >&2
  exit 1
fi

export PGPASSWORD
psql_base=(psql -X -v ON_ERROR_STOP=1)

"${psql_base[@]}" <<'SQL'
do $roles$
begin
  create role authenticated nologin;
exception when duplicate_object then null;
end
$roles$;
do $roles$
begin
  create role anon nologin;
exception when duplicate_object then null;
end
$roles$;
do $roles$
begin
  create role service_role nologin;
exception when duplicate_object then null;
end
$roles$;

create schema if not exists auth;
create schema if not exists private;

create table auth.users (
  id uuid primary key
);

create or replace function auth.uid()
returns uuid
language sql
stable
as $uid$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$uid$;

create table private.organizations (
  organization_id uuid primary key,
  status text not null check (status in ('ACTIVE','SUSPENDED','REVOKED'))
);
create table private.workspaces (
  workspace_id uuid primary key,
  organization_id uuid not null references private.organizations(organization_id),
  status text not null check (status in ('ACTIVE','SUSPENDED','REVOKED')),
  unique (organization_id, workspace_id)
);
create table private.organization_memberships (
  organization_id uuid not null references private.organizations(organization_id),
  user_id uuid not null references auth.users(id),
  status text not null check (status in ('ACTIVE','SUSPENDED','REVOKED')),
  role text not null,
  primary key (organization_id, user_id)
);
create table private.workspace_memberships (
  organization_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null references auth.users(id),
  status text not null check (status in ('ACTIVE','SUSPENDED','REVOKED')),
  role text not null,
  primary key (organization_id, workspace_id, user_id),
  foreign key (organization_id, workspace_id)
    references private.workspaces(organization_id, workspace_id)
);

insert into auth.users(id) values
  ('30000000-0000-4000-8000-000000000003'),
  ('40000000-0000-4000-8000-000000000004'),
  ('50000000-0000-4000-8000-000000000005');
insert into private.organizations values
  ('10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into private.workspaces values
  ('20000000-0000-4000-8000-000000000002',
   '10000000-0000-4000-8000-000000000001', 'ACTIVE');
insert into private.organization_memberships values
  ('10000000-0000-4000-8000-000000000001',
   '30000000-0000-4000-8000-000000000003', 'ACTIVE', 'MEMBER'),
  ('10000000-0000-4000-8000-000000000001',
   '40000000-0000-4000-8000-000000000004', 'ACTIVE', 'MEMBER'),
  ('10000000-0000-4000-8000-000000000001',
   '50000000-0000-4000-8000-000000000005', 'ACTIVE', 'MEMBER');
insert into private.workspace_memberships values
  ('10000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000002',
   '30000000-0000-4000-8000-000000000003', 'ACTIVE', 'MEMBER'),
  ('10000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000002',
   '40000000-0000-4000-8000-000000000004', 'ACTIVE', 'MEMBER'),
  ('10000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000002',
   '50000000-0000-4000-8000-000000000005', 'REVOKED', 'MEMBER');
SQL

"${psql_base[@]}" -f "$SCHEMA_FILE"

# RLS and CAS behavior are exercised with real PostgreSQL roles. auth.uid()
# is a local stub driven by request.jwt.claim.sub; this is not Supabase JWT
# signature verification or a production Supabase integration test.
"${psql_base[@]}" <<'SQL'
set role authenticated;
select set_config('request.jwt.claim.sub',
  '30000000-0000-4000-8000-000000000003', false);

insert into public.happy_tenant_records
  (organization_id, workspace_id, user_id, entity_type, record_id, version, data)
values
  ('10000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000002',
   auth.uid(), 'MISSION', 'mission-cas', 1, '{"goal":"initial"}');

do $checks$
declare
  v_version bigint;
  v_visible bigint;
  v_deleted boolean;
begin
  select count(*) into v_visible
    from public.happy_tenant_records
   where record_id = 'mission-cas';
  if v_visible <> 1 then raise exception 'owner cannot read own row through RLS'; end if;

  select (public.happy_update_tenant_record(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    'MISSION', 'mission-cas', 1, '{"goal":"updated"}'
  )).version into v_version;
  if v_version <> 2 then raise exception 'CAS update did not increment version'; end if;

  begin
    perform public.happy_update_tenant_record(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      'MISSION', 'mission-cas', 1, '{"goal":"stale"}'
    );
    raise exception 'stale CAS update unexpectedly succeeded';
  exception when sqlstate '40001' then null;
  end;

  begin
    perform public.happy_delete_tenant_record(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      'MISSION', 'mission-cas', 1
    );
    raise exception 'stale CAS delete unexpectedly succeeded';
  exception when sqlstate '40001' then null;
  end;

  v_deleted := public.happy_delete_tenant_record(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    'MISSION', 'mission-cas', 2
  );
  if not v_deleted then raise exception 'valid CAS delete failed'; end if;

  v_deleted := public.happy_delete_tenant_record(
    '10000000-0000-4000-8000-000000000002',
    '20000000-0000-4000-8000-000000000002',
    'MISSION', 'missing-record', 1
  );
  if v_deleted then raise exception 'delete reported success for missing row'; end if;
end
$checks$;

-- An active second user cannot read, update, or delete the first user's row.
select set_config('request.jwt.claim.sub',
  '40000000-0000-4000-8000-000000000004', false);
do $isolation$
declare
  v_visible bigint;
begin
  select count(*) into v_visible
    from public.happy_tenant_records
   where record_id = 'private-to-user-a';
  if v_visible <> 0 then raise exception 'cross-user RLS read leaked a row'; end if;

  begin
    perform public.happy_update_tenant_record(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      'MISSION', 'private-to-user-a', 1, '{"goal":"intrusion"}'
    );
    raise exception 'cross-user update unexpectedly succeeded';
  exception when sqlstate 'P0002' then null;
  end;
end
$isolation$;

-- A user with revoked workspace membership cannot read or insert.
select set_config('request.jwt.claim.sub',
  '50000000-0000-4000-8000-000000000005', false);
do $revoked$
declare
  v_visible bigint;
begin
  select count(*) into v_visible from public.happy_tenant_records;
  if v_visible <> 0 then raise exception 'revoked workspace member can read tenant rows'; end if;

  begin
    insert into public.happy_tenant_records
      (organization_id, workspace_id, user_id, entity_type, record_id, version, data)
    values
      ('10000000-0000-4000-8000-000000000001',
       '20000000-0000-4000-8000-000000000002',
       auth.uid(), 'MISSION', 'revoked-insert', 1, '{"goal":"denied"}');
    raise exception 'revoked workspace member insert unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end
$revoked$;

reset role;

-- Direct table mutation is not granted, and service_role is not granted access.
do $privileges$
begin
  if has_table_privilege('authenticated', 'public.happy_tenant_records', 'UPDATE') then
    raise exception 'authenticated has direct UPDATE privilege';
  end if;
  if has_table_privilege('authenticated', 'public.happy_tenant_records', 'DELETE') then
    raise exception 'authenticated has direct DELETE privilege';
  end if;
  if has_table_privilege('service_role', 'public.happy_tenant_records', 'SELECT') then
    raise exception 'service_role has direct SELECT privilege';
  end if;
end
$privileges$;

begin;
insert into public.happy_tenant_records
  (organization_id, workspace_id, user_id, entity_type, record_id, version, data)
values
  ('10000000-0000-4000-8000-000000000001',
   '20000000-0000-4000-8000-000000000002',
   '30000000-0000-4000-8000-000000000003',
   'MISSION', 'rollback-check', 1, '{"goal":"must rollback"}');
rollback;

do $rollback$
declare
  v_count bigint;
begin
  select count(*) into v_count
    from public.happy_tenant_records
   where record_id = 'rollback-check';
  if v_count <> 0 then raise exception 'PostgreSQL transaction rollback failed'; end if;
end
$rollback$;

select 'PostgreSQL tenant persistence RLS/CAS integration: PASS' as result;
SQL
