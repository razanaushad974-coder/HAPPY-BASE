#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGPORT:?PGPORT is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${PGDATABASE:?PGDATABASE is required}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SCHEMA_FILE="$ROOT_DIR/supabase/drafts/20261119_async_tenant_persistence_schema_candidate.sql"
SCHEDULER_SCHEMA_FILE="$ROOT_DIR/supabase/drafts/20261121_durable_mission_scheduler_candidate.sql"
TENANT_CONTEXT_RPC_FILE="$ROOT_DIR/supabase/drafts/20261121_authenticated_tenant_context_rpc_candidate.sql"
RACE_SCRIPT="$ROOT_DIR/scripts/security/postgres-tenant-cas-concurrency.sh"
RECONCILIATION_RACE_SCRIPT="$ROOT_DIR/scripts/security/postgres-reconciliation-evidence-concurrency.sh"
for required_file in "$SCHEMA_FILE" "$SCHEDULER_SCHEMA_FILE" "$TENANT_CONTEXT_RPC_FILE" "$RACE_SCRIPT" "$RECONCILIATION_RACE_SCRIPT"; do
  if [[ ! -f "$required_file" ]]; then
    echo "Required tenant persistence test file not found: $required_file" >&2
    exit 1
  fi
done

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
grant usage on schema auth to authenticated, anon, service_role;

create table auth.users (id uuid primary key);
create or replace function auth.uid()
returns uuid
language sql
stable
as $uid$
  select nullif(current_setting('request.jwt.claim.sub', true), '')::uuid;
$uid$;
grant execute on function auth.uid() to authenticated, anon, service_role;

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

alter table private.organizations enable row level security;
alter table private.workspaces enable row level security;
alter table private.organization_memberships enable row level security;
alter table private.workspace_memberships enable row level security;
revoke all on schema private from public, anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update on private.organizations, private.workspaces,
  private.organization_memberships, private.workspace_memberships to service_role;
SQL

"${psql_base[@]}" -f "$SCHEMA_FILE"
"${psql_base[@]}" -f "$SCHEDULER_SCHEMA_FILE"
"${psql_base[@]}" -f "$TENANT_CONTEXT_RPC_FILE"

# Real PostgreSQL 17 roles/RLS/functions; auth.uid() is stubbed from a local
# claim setting. This is not Supabase JWT signature or hosted-project testing.
"${psql_base[@]}" <<'SQL'
set role authenticated;
select set_config('request.jwt.claim.sub',
  '30000000-0000-4000-8000-000000000003', false);

do $tenant_context_rpc$
declare
  v_context record;
  v_count bigint;
begin
  select * into v_context
    from public.resolve_authenticated_tenant_context(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002'
    );
  if not found
     or v_context.user_id <> auth.uid()
     or v_context.organization_id <> '10000000-0000-4000-8000-000000000001'
     or v_context.workspace_id <> '20000000-0000-4000-8000-000000000002'
     or v_context.organization_role <> 'MEMBER'
     or v_context.workspace_role <> 'MEMBER' then
    raise exception 'authenticated tenant context RPC did not return the exact active scope';
  end if;

  perform set_config('request.jwt.claim.sub',
    '50000000-0000-4000-8000-000000000005', false);
  select count(*) into v_count
    from public.resolve_authenticated_tenant_context(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002'
    );
  if v_count <> 0 then
    raise exception 'revoked workspace member received tenant context';
  end if;

  perform set_config('request.jwt.claim.sub',
    '30000000-0000-4000-8000-000000000003', false);
end
$tenant_context_rpc$;

select * from public.happy_create_tenant_record(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  'MISSION', 'mission-cas', '{"goal":"initial"}'
);

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

  begin
    perform public.happy_create_tenant_record(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      'MISSION', 'mission-cas', '{"goal":"duplicate"}'
    );
    raise exception 'duplicate tenant create unexpectedly succeeded';
  exception when unique_violation then null;
  end;

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
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    'MISSION', 'missing-record', 1
  );
  if v_deleted then raise exception 'delete reported success for missing row'; end if;
end
$checks$;

select * from public.happy_create_tenant_record(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  'MISSION', 'private-to-user-a', '{"goal":"private"}'
);

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

select set_config('request.jwt.claim.sub',
  '50000000-0000-4000-8000-000000000005', false);
do $revoked$
declare
  v_visible bigint;
begin
  select count(*) into v_visible from public.happy_tenant_records;
  if v_visible <> 0 then raise exception 'revoked workspace member can read tenant rows'; end if;

  begin
    perform public.happy_create_tenant_record(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      'MISSION', 'revoked-rpc-create', '{"goal":"denied"}'
    );
    raise exception 'revoked workspace member create RPC unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;

  begin
    insert into public.happy_tenant_records
      (organization_id, workspace_id, user_id, entity_type, record_id, version, data)
    values
      ('10000000-0000-4000-8000-000000000001',
       '20000000-0000-4000-8000-000000000002',
       auth.uid(), 'MISSION', 'revoked-direct-insert', 1, '{"goal":"denied"}');
    raise exception 'direct authenticated INSERT unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end
$revoked$;

reset role;

do $privileges$
begin
  if has_schema_privilege('authenticated', 'private', 'USAGE') then
    raise exception 'authenticated has direct private-schema USAGE';
  end if;
  if has_table_privilege('authenticated', 'private.organization_memberships', 'SELECT') then
    raise exception 'authenticated has direct private membership SELECT';
  end if;
  if not has_function_privilege('authenticated', 'public.resolve_authenticated_tenant_context(uuid,uuid)', 'EXECUTE') then
    raise exception 'authenticated cannot execute the user-scoped tenant context RPC';
  end if;
  if has_function_privilege('anon', 'public.resolve_authenticated_tenant_context(uuid,uuid)', 'EXECUTE')
     or has_function_privilege('service_role', 'public.resolve_authenticated_tenant_context(uuid,uuid)', 'EXECUTE') then
    raise exception 'tenant context RPC is executable by anon or service_role';
  end if;
  if has_table_privilege('authenticated', 'public.happy_tenant_records', 'INSERT') then
    raise exception 'authenticated has direct INSERT privilege';
  end if;
  if has_function_privilege('authenticated', 'public.happy_lock_active_tenant_scope(uuid,uuid)', 'EXECUTE') then
    raise exception 'authenticated can invoke the internal membership lock helper';
  end if;
  if has_function_privilege('service_role', 'public.happy_create_tenant_record(uuid,uuid,text,text,jsonb)', 'EXECUTE') then
    raise exception 'service_role can invoke the user-scoped create RPC';
  end if;
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


# Durable scheduler SQL candidate: claim eligibility, dependency gating,
# lease fencing/reclaim, transactional outbox, and idempotent intent insertion.
"${psql_base[@]}" <<'SQL'
set role authenticated;
select set_config('request.jwt.claim.sub',
  '30000000-0000-4000-8000-000000000003', false);
select * from public.happy_create_tenant_record(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  'MISSION', 'mission-scheduler',
  '{"status":"READY","taskIds":["task-scheduler-root","task-scheduler-child","task-scheduler-reclaim"]}'
);
select * from public.happy_create_tenant_record(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  'TASK', 'task-scheduler-root',
  '{"missionId":"mission-scheduler","status":"READY","dependencyIds":[]}'
);
select * from public.happy_create_tenant_record(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  'TASK', 'task-scheduler-child',
  '{"missionId":"mission-scheduler","status":"READY","dependencyIds":["task-scheduler-root"]}'
);
select * from public.happy_create_tenant_record(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  'TASK', 'task-scheduler-reclaim',
  '{"missionId":"mission-scheduler","status":"READY","dependencyIds":[]}'
);
do $scheduler$
declare
  v_claim record;
  v_outbox public.happy_execution_dispatch_outbox%rowtype;
  v_duplicate public.happy_execution_dispatch_outbox%rowtype;
  v_dispatched public.happy_execution_dispatch_outbox%rowtype;
  v_recorded public.happy_execution_dispatch_outbox%rowtype;
  v_heartbeat timestamptz;
  v_payload jsonb;
begin
  begin
    perform * from public.happy_claim_mission_task(
      '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
      'mission-scheduler','task-scheduler-child','worker-a',30000
    );
    raise exception 'task with incomplete dependency was claimed';
  exception when sqlstate '55000' then
    if sqlerrm <> 'TASK_DEPENDENCY_NOT_COMPLETED' then raise; end if;
  end;
  select * into v_claim from public.happy_claim_mission_task(
    '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
    'mission-scheduler','task-scheduler-root','worker-a',30000
  );
  if v_claim.attempt <> 1 or v_claim.fencing_token <> 1 then
    raise exception 'initial lease must start at attempt/fencing token 1';
  end if;
  v_payload := '{"id":"request-scheduler-1","missionId":"mission-scheduler","taskId":"task-scheduler-root","capability":"API","action":"POST","input":{"value":1},"requiresApproval":false,"approved":false,"risk":"LOW","createdAt":"2026-11-21T12:00:00.000Z"}'::jsonb;
  v_outbox := public.happy_enqueue_mission_dispatch(
    '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
    'mission-scheduler','task-scheduler-root',v_claim.lease_id,'worker-a',v_claim.fencing_token,
    'request-scheduler-1','tenant-attempt-key-1','API','POST',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',v_payload
  );
  v_duplicate := public.happy_enqueue_mission_dispatch(
    '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
    'mission-scheduler','task-scheduler-root',v_claim.lease_id,'worker-a',v_claim.fencing_token,
    'request-scheduler-1','tenant-attempt-key-1','API','POST',
    'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',v_payload
  );
  if v_duplicate.outbox_id <> v_outbox.outbox_id then
    raise exception 'identical idempotent dispatch did not return original outbox row';
  end if;
  v_heartbeat := public.happy_heartbeat_mission_task_lease(
    '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
    'mission-scheduler','task-scheduler-root',v_claim.lease_id,'worker-a',v_claim.fencing_token,30000
  );
  if v_heartbeat <= clock_timestamp() then
    raise exception 'valid lease heartbeat did not extend expiry';
  end if;
  v_dispatched := public.happy_claim_dispatch_outbox(
    '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
    v_outbox.outbox_id,v_claim.lease_id,'worker-a',v_claim.fencing_token
  );
  if v_dispatched.status <> 'DISPATCHED' then
    raise exception 'outbox claim did not transition PENDING to DISPATCHED';
  end if;
  v_recorded := public.happy_record_dispatch_outcome(
    '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
    v_outbox.outbox_id,v_claim.lease_id,'worker-a',v_claim.fencing_token,
    'ACKNOWLEDGED','{"provider":"test-provider","providerRequestId":"provider-req-1","httpStatus":200}'::jsonb
  );
  if v_recorded.status <> 'ACKNOWLEDGED'
     or v_recorded.outcome->>'providerRequestId' <> 'provider-req-1' then
    raise exception 'provider outcome was not persisted with exact dispatch record';
  end if;
  begin
    perform public.happy_record_dispatch_outcome(
      '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
      v_outbox.outbox_id,v_claim.lease_id,'worker-a',v_claim.fencing_token,
      'ACKNOWLEDGED','{"providerRequestId":"different"}'::jsonb
    );
    raise exception 'second provider outcome unexpectedly overwrote immutable result';
  exception when sqlstate '55000' then
    if sqlerrm <> 'OUTBOX_OUTCOME_ALREADY_RECORDED_OR_NOT_DISPATCHED' then raise; end if;
  end;
  begin
    perform public.happy_claim_dispatch_outbox(
      '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
      v_outbox.outbox_id,v_claim.lease_id,'worker-a',v_claim.fencing_token
    );
    raise exception 'already claimed outbox was returned twice';
  exception when sqlstate '55000' then
    if sqlerrm <> 'OUTBOX_ALREADY_CLAIMED_OR_REQUIRES_RECONCILIATION' then raise; end if;
  end;
  begin
    perform public.happy_enqueue_mission_dispatch(
      '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
      'mission-scheduler','task-scheduler-root',v_claim.lease_id,'worker-a',v_claim.fencing_token,
      'request-scheduler-1','tenant-attempt-key-1','API','POST',
      'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
      jsonb_set(v_payload,'{input,value}','2'::jsonb)
    );
    raise exception 'idempotency key reuse with changed payload unexpectedly succeeded';
  exception when unique_violation then null;
  end;
  begin
    perform * from public.happy_claim_mission_task(
      '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
      'mission-scheduler','task-scheduler-root','worker-b',30000
    );
    raise exception 'active lease was unexpectedly stolen';
  exception when sqlstate '55000' then
    if sqlerrm <> 'RUNNING_TASK_REQUIRES_RECONCILIATION' then raise; end if;
  end;
end
$scheduler$;
reset role;
update public.happy_mission_task_leases
   set expires_at = clock_timestamp() - interval '1 second'
 where organization_id = '10000000-0000-4000-8000-000000000001'
   and workspace_id = '20000000-0000-4000-8000-000000000002'
   and user_id = '30000000-0000-4000-8000-000000000003'
   and mission_id = 'mission-scheduler' and task_id = 'task-scheduler-root';
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false);
do $fencing$
declare
  v_first record;
begin
  begin
    perform * from public.happy_claim_mission_task(
      '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
      'mission-scheduler','task-scheduler-root','worker-b',30000
    );
    raise exception 'expired lease with an existing outbox was replayed';
  exception when sqlstate '55000' then
    if sqlerrm <> 'RUNNING_TASK_REQUIRES_RECONCILIATION' then raise; end if;
  end;
  select * into v_first from public.happy_claim_mission_task(
    '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
    'mission-scheduler','task-scheduler-reclaim','worker-a',30000
  );
  if v_first.attempt <> 1 or v_first.fencing_token <> 1 then
    raise exception 'fresh reclaim-test lease must start at 1';
  end if;
end
$fencing$;
reset role;
update public.happy_mission_task_leases
   set expires_at = clock_timestamp() - interval '1 second'
 where organization_id = '10000000-0000-4000-8000-000000000001'
   and workspace_id = '20000000-0000-4000-8000-000000000002'
   and user_id = '30000000-0000-4000-8000-000000000003'
   and mission_id = 'mission-scheduler' and task_id = 'task-scheduler-reclaim';
set role authenticated;
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false);
do $fencing_reclaim$
declare
  v_reclaimed record;
  v_reclaim_outbox public.happy_execution_dispatch_outbox%rowtype;
  v_ambiguous public.happy_execution_dispatch_outbox%rowtype;
begin
  select * into v_reclaimed from public.happy_claim_mission_task(
    '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
    'mission-scheduler','task-scheduler-reclaim','worker-b',30000
  );
  if v_reclaimed.attempt <> 2 or v_reclaimed.fencing_token <> 2 then
    raise exception 'reclaimed lease did not advance attempt and fencing token';
  end if;
  begin
    perform public.happy_heartbeat_mission_task_lease(
      '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
      'mission-scheduler','task-scheduler-reclaim',v_reclaimed.lease_id,'worker-a',1,30000
    );
    raise exception 'stale worker heartbeat unexpectedly succeeded';
  exception when sqlstate '55000' then
    if sqlerrm <> 'STALE_OR_EXPIRED_LEASE' then raise; end if;
  end;
  begin
    perform public.happy_enqueue_mission_dispatch(
      '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
      'mission-scheduler','task-scheduler-reclaim',v_reclaimed.lease_id,'worker-a',1,
      'request-old-worker','old-key','API','POST',
      'sha256:cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
      '{"id":"request-old-worker","missionId":"mission-scheduler","taskId":"task-scheduler-reclaim","capability":"API","action":"POST"}'
    );
    raise exception 'stale worker dispatch unexpectedly succeeded';
  exception when sqlstate '55000' then
    if sqlerrm <> 'STALE_OR_EXPIRED_LEASE' then raise; end if;
  end;
  v_reclaim_outbox := public.happy_enqueue_mission_dispatch(
    '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
    'mission-scheduler','task-scheduler-reclaim',v_reclaimed.lease_id,'worker-b',v_reclaimed.fencing_token,
    'request-scheduler-2','tenant-attempt-key-2','API','POST',
    'sha256:dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
    '{"id":"request-scheduler-2","missionId":"mission-scheduler","taskId":"task-scheduler-reclaim","capability":"API","action":"POST"}'
  );
  perform public.happy_claim_dispatch_outbox(
    '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
    v_reclaim_outbox.outbox_id,v_reclaimed.lease_id,'worker-b',v_reclaimed.fencing_token
  );
  v_ambiguous := public.happy_record_dispatch_outcome(
    '10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002',
    v_reclaim_outbox.outbox_id,v_reclaimed.lease_id,'worker-b',v_reclaimed.fencing_token,
    'AMBIGUOUS','{"provider":"test-provider","reason":"provider_timeout_after_send","retryAllowed":false}'::jsonb
  );
  if v_ambiguous.status <> 'AMBIGUOUS' then
    raise exception 'ambiguous provider outcome was not preserved for reconciliation';
  end if;
end
$fencing_reclaim$;

-- Append-only provider reconciliation evidence: tenant/outbox binding,
-- idempotent event identity, collision rejection, and immutable original result.
-- Run the function body as the local database owner because internal outbox
-- rows intentionally have no direct authenticated SELECT grant. auth.uid()
-- remains derived from the simulated request claim; RPC EXECUTE grants are
-- checked independently below.
reset role;
do $reconciliation$
declare
  v_outbox public.happy_execution_dispatch_outbox%rowtype;
  v_evidence_id uuid := '90000000-0000-4000-8000-000000000009';
  v_result uuid;
  v_count bigint;
  v_observed_at timestamptz := clock_timestamp();
begin
  select * into v_outbox
    from public.happy_execution_dispatch_outbox
   where execution_request_id = 'request-scheduler-2';
  if not found or v_outbox.status <> 'AMBIGUOUS' then
    raise exception 'expected ambiguous outbox row for reconciliation tests';
  end if;

  v_result := public.happy_append_dispatch_reconciliation_evidence(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    v_outbox.outbox_id, v_evidence_id, v_outbox.idempotency_key,
    'test-provider', 'PROCESSING', v_observed_at,
    '{"status":"PROCESSING","providerRequestId":"provider-req-2"}'::jsonb
  );
  if v_result <> v_evidence_id then raise exception 'append RPC returned wrong evidence ID'; end if;

  -- Identical event retry is idempotent.
  v_result := public.happy_append_dispatch_reconciliation_evidence(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    v_outbox.outbox_id, v_evidence_id, v_outbox.idempotency_key,
    'test-provider', 'PROCESSING',
    v_observed_at,
    '{"status":"PROCESSING","providerRequestId":"provider-req-2"}'::jsonb
  );
  if v_result <> v_evidence_id then raise exception 'identical evidence retry was not idempotent'; end if;

  select count(*) into v_count
    from public.happy_dispatch_reconciliation_evidence
   where evidence_id = v_evidence_id;
  if v_count <> 1 then raise exception 'idempotent retry created duplicate evidence'; end if;

  -- A distinct observation ID appends a new event instead of rewriting the first.
  perform public.happy_append_dispatch_reconciliation_evidence(
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    v_outbox.outbox_id, '90000000-0000-4000-8000-000000000010',
    v_outbox.idempotency_key, 'test-provider', 'SUCCEEDED',
    v_observed_at + interval '1 second',
    '{"status":"SUCCEEDED","providerRequestId":"provider-req-2"}'::jsonb
  );

  begin
    perform public.happy_append_dispatch_reconciliation_evidence(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      v_outbox.outbox_id, v_evidence_id, v_outbox.idempotency_key,
      'test-provider', 'SUCCEEDED', clock_timestamp(),
      '{"status":"SUCCEEDED","providerRequestId":"different"}'::jsonb
    );
    raise exception 'evidence ID payload collision unexpectedly succeeded';
  exception when unique_violation then null;
  end;

  begin
    perform public.happy_append_dispatch_reconciliation_evidence(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      v_outbox.outbox_id, gen_random_uuid(), v_outbox.idempotency_key,
      'other-provider', 'PROCESSING', clock_timestamp(),
      '{"status":"PROCESSING"}'::jsonb
    );
    raise exception 'provider identity mismatch unexpectedly succeeded';
  exception when sqlstate '55000' then
    if sqlerrm <> 'RECONCILIATION_TARGET_BINDING_MISMATCH' then raise; end if;
  end;

  begin
    perform public.happy_append_dispatch_reconciliation_evidence(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      v_outbox.outbox_id, gen_random_uuid(), 'wrong-idempotency-key',
      'test-provider', 'PROCESSING', clock_timestamp(),
      '{"status":"PROCESSING"}'::jsonb
    );
    raise exception 'idempotency key mismatch unexpectedly succeeded';
  exception when sqlstate '55000' then
    if sqlerrm <> 'RECONCILIATION_TARGET_BINDING_MISMATCH' then raise; end if;
  end;

  begin
    perform public.happy_append_dispatch_reconciliation_evidence(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      v_outbox.outbox_id, gen_random_uuid(), v_outbox.idempotency_key,
      'test-provider', 'PROCESSING', clock_timestamp(),
      '{"status":"SUCCEEDED"}'::jsonb
    );
    raise exception 'observation status/payload mismatch unexpectedly succeeded';
  exception when invalid_parameter_value then null;
  end;

  begin
    perform public.happy_append_dispatch_reconciliation_evidence(
      '11000000-0000-4000-8000-000000000011',
      '20000000-0000-4000-8000-000000000002',
      v_outbox.outbox_id, gen_random_uuid(), v_outbox.idempotency_key,
      'test-provider', 'PROCESSING', clock_timestamp(),
      '{"status":"PROCESSING"}'::jsonb
    );
    raise exception 'foreign tenant reconciliation append unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;

  perform set_config('request.jwt.claim.sub',
    '50000000-0000-4000-8000-000000000005', true);
  begin
    perform public.happy_append_dispatch_reconciliation_evidence(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      v_outbox.outbox_id, gen_random_uuid(), v_outbox.idempotency_key,
      'test-provider', 'PROCESSING', clock_timestamp(),
      '{"status":"PROCESSING"}'::jsonb
    );
    raise exception 'revoked member reconciliation append unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
  perform set_config('request.jwt.claim.sub',
    '30000000-0000-4000-8000-000000000003', true);

  select * into v_outbox
    from public.happy_execution_dispatch_outbox
   where outbox_id = v_outbox.outbox_id;
  if v_outbox.status <> 'AMBIGUOUS'
     or v_outbox.outcome->>'reason' <> 'provider_timeout_after_send' then
    raise exception 'reconciliation mutated original immutable dispatch outcome';
  end if;

  select count(*) into v_count
    from public.happy_dispatch_reconciliation_evidence
   where outbox_id = v_outbox.outbox_id;
  if v_count <> 2 then raise exception 'distinct provider observations were not appended independently'; end if;
end
$reconciliation$;

-- Even the table owner cannot accidentally mutate evidence through ordinary DML.
do $append_only$
begin
  begin
    update public.happy_dispatch_reconciliation_evidence
       set observation = '{"status":"SUCCEEDED"}'::jsonb
     where evidence_id = '90000000-0000-4000-8000-000000000009';
    raise exception 'append-only evidence UPDATE unexpectedly succeeded';
  exception when sqlstate '55000' then
    if sqlerrm <> 'RECONCILIATION_EVIDENCE_APPEND_ONLY' then raise; end if;
  end;
  begin
    delete from public.happy_dispatch_reconciliation_evidence
     where evidence_id = '90000000-0000-4000-8000-000000000009';
    raise exception 'append-only evidence DELETE unexpectedly succeeded';
  exception when sqlstate '55000' then
    if sqlerrm <> 'RECONCILIATION_EVIDENCE_APPEND_ONLY' then raise; end if;
  end;
end
$append_only$;

do $scheduler_privileges$
begin
  if has_table_privilege('authenticated','public.happy_mission_task_leases','SELECT')
     or has_table_privilege('authenticated','public.happy_mission_task_leases','INSERT')
     or has_table_privilege('authenticated','public.happy_execution_dispatch_outbox','SELECT')
     or has_table_privilege('authenticated','public.happy_execution_dispatch_outbox','INSERT') then
    raise exception 'authenticated can access scheduler internals directly';
  end if;
  if not has_function_privilege('authenticated','public.happy_append_dispatch_reconciliation_evidence(uuid,uuid,uuid,uuid,text,text,text,timestamptz,jsonb)','EXECUTE') then
    raise exception 'authenticated cannot invoke reconciliation append RPC';
  end if;
  if has_table_privilege('authenticated','public.happy_dispatch_reconciliation_evidence','SELECT')
     or has_table_privilege('authenticated','public.happy_dispatch_reconciliation_evidence','INSERT')
     or has_table_privilege('authenticated','public.happy_dispatch_reconciliation_evidence','UPDATE')
     or has_table_privilege('authenticated','public.happy_dispatch_reconciliation_evidence','DELETE') then
    raise exception 'authenticated has direct access to reconciliation evidence table';
  end if;
  if has_function_privilege('service_role','public.happy_append_dispatch_reconciliation_evidence(uuid,uuid,uuid,uuid,text,text,text,timestamptz,jsonb)','EXECUTE') then
    raise exception 'service_role can invoke reconciliation append RPC';
  end if;
  if has_function_privilege('service_role','public.happy_claim_mission_task(uuid,uuid,text,text,text,integer)','EXECUTE')
     or has_function_privilege('service_role','public.happy_enqueue_mission_dispatch(uuid,uuid,text,text,uuid,text,bigint,text,text,text,text,text,jsonb)','EXECUTE')
     or has_function_privilege('service_role','public.happy_heartbeat_mission_task_lease(uuid,uuid,text,text,uuid,text,bigint,integer)','EXECUTE')
     or has_function_privilege('service_role','public.happy_claim_dispatch_outbox(uuid,uuid,uuid,uuid,text,bigint)','EXECUTE')
     or has_function_privilege('service_role','public.happy_record_dispatch_outcome(uuid,uuid,uuid,uuid,text,bigint,text,jsonb)','EXECUTE') then
    raise exception 'service_role can invoke authenticated scheduler RPCs';
  end if;
end
$scheduler_privileges$;
select 'PostgreSQL durable mission lease/outbox integration: PASS' as result;
SQL

bash "$RECONCILIATION_RACE_SCRIPT"
bash "$RACE_SCRIPT"
