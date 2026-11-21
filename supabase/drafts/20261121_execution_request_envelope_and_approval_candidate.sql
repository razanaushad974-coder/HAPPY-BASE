-- DESIGN-ONLY candidate. DO NOT APPLY to a connected/shared/production Supabase project.
-- Depends on private.execution_requests, private.organizations/workspaces,
-- private.organization_memberships, private.workspace_memberships from
-- 20261119_file_mutation_atomic_consume_candidate.sql.
--
-- This schema matches SupabaseDurableExecutionRequestStore and the creator /
-- decision RPC contracts. It is intentionally a high-risk, FOUNDER-approved
-- request path: creation derives requester=executor=auth.uid(), fixes risk=HIGH,
-- requires_approval=true and required_approval_role=FOUNDER. Delegation is not
-- supported. No request body can set approval state or approver identity.
--
-- Approval is a one-way atomic decision. Only a different active FOUNDER can
-- approve/reject. Approved requests become READY; rejected requests CANCELLED.
-- Claim is one-shot, fenced by a short lease, and never replays expired work.
-- This does not itself wire an execution route, worker, or live adapter.
--
-- Deployment gate: reconcile all pre-existing rows explicitly (no fabricated
-- backfill), validate Supabase's role ownership model, RLS/FORCE RLS, grants,
-- lock ordering, and test with real user JWTs. The dedicated BYPASSRLS roles
-- below have narrowly scoped table privileges; never substitute service_role.

alter table private.execution_requests
  add column capability text,
  add column action text,
  add column input jsonb,
  add column target_reference jsonb,
  add column risk text,
  add column requires_approval boolean,
  add column approval_status text,
  add column required_approval_role text,
  add column approver_user_id uuid references auth.users(id) on delete restrict,
  add column decided_at timestamptz,
  add column decision_reason text,
  add column idempotency_key text,
  add column input_digest text,
  add column created_at timestamptz not null default clock_timestamp();

do $legacy$
begin
  if exists(select 1 from private.execution_requests where capability is null
    or action is null or input is null or risk is null or requires_approval is null
    or approval_status is null or required_approval_role is null
    or idempotency_key is null or input_digest is null) then
    raise exception 'LEGACY_EXECUTION_REQUESTS_REQUIRE_EXPLICIT_BACKFILL';
  end if;
end
$legacy$;

alter table private.execution_requests
  alter column capability set not null,
  alter column action set not null,
  alter column input set not null,
  alter column risk set not null,
  alter column requires_approval set not null,
  alter column approval_status set not null,
  alter column required_approval_role set not null,
  alter column idempotency_key set not null,
  alter column input_digest set not null,
  add constraint execution_requests_capability_check
    check(capability in ('CODE','FILE','API','BROWSER','SHELL','DATABASE','AI','DEPLOYMENT','PUBLISH','AUTOMATION')),
  add constraint execution_requests_action_check check(length(btrim(action)) between 1 and 200),
  add constraint execution_requests_input_check check(jsonb_typeof(input)='object'),
  add constraint execution_requests_target_reference_check
    check(target_reference is null or jsonb_typeof(target_reference)='object'),
  add constraint execution_requests_risk_check check(risk in ('LOW','MEDIUM','HIGH','CRITICAL')),
  add constraint execution_requests_approval_status_check check(approval_status in ('PENDING','APPROVED','REJECTED')),
  add constraint execution_requests_required_role_check check(required_approval_role='FOUNDER'),
  add constraint execution_requests_idempotency_check check(length(btrim(idempotency_key)) between 1 and 160),
  add constraint execution_requests_digest_check check(input_digest ~ '^[0-9a-f]{64}$'),
  add constraint execution_requests_approval_consistency_check
    check(requires_approval and risk='HIGH'),
  add constraint execution_requests_decision_consistency_check check(
    (approval_status='PENDING' and approver_user_id is null and decided_at is null
      and decision_reason is null and status='WAITING_APPROVAL')
    or
    (approval_status='APPROVED' and approver_user_id is not null and decided_at is not null
      and decision_reason is not null and length(btrim(decision_reason))>0
      and status='READY')
    or
    (approval_status='REJECTED' and approver_user_id is not null and decided_at is not null
      and decision_reason is not null and length(btrim(decision_reason))>0 and status='CANCELLED')
  ),
  add constraint execution_requests_completion_consistency_check check(
    (status='CANCELLED' and approval_status='REJECTED')
    or (status<>'CANCELLED' and approval_status<>'REJECTED')
  );

alter table private.execution_requests
  drop constraint if exists execution_requests_status_check,
  add constraint execution_requests_lifecycle_status_check
    check(status in ('WAITING_APPROVAL','READY','CANCELLED'));

create unique index execution_requests_idempotency_scope_idx
  on private.execution_requests(organization_id,workspace_id,requester_user_id,idempotency_key);
create index execution_requests_executor_status_idx
  on private.execution_requests(executor_user_id,status,created_at);

create table private.execution_request_decision_events (
  event_id uuid primary key default gen_random_uuid(),
  request_id text not null references private.execution_requests(request_id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  decision text not null check(decision in ('APPROVED','REJECTED')),
  reason text not null check(length(btrim(reason)) between 1 and 1000),
  occurred_at timestamptz not null
);
create index execution_request_decision_events_request_idx
  on private.execution_request_decision_events(request_id,occurred_at);
alter table private.execution_request_decision_events enable row level security;
revoke all on private.execution_request_decision_events from public,anon,authenticated,service_role;

create or replace function private.guard_execution_request_update()
returns trigger language plpgsql set search_path=pg_catalog as $guard$
begin
  if row(new.request_id,new.task_id,new.mission_id,new.requester_user_id,new.executor_user_id,
    new.organization_id,new.workspace_id,new.capability,new.action,new.input,new.target_reference,
    new.risk,new.requires_approval,new.required_approval_role,new.idempotency_key,new.input_digest,new.created_at)
    is distinct from row(old.request_id,old.task_id,old.mission_id,old.requester_user_id,old.executor_user_id,
    old.organization_id,old.workspace_id,old.capability,old.action,old.input,old.target_reference,
    old.risk,old.requires_approval,old.required_approval_role,old.idempotency_key,old.input_digest,old.created_at) then
    raise exception 'EXECUTION_REQUEST_ENVELOPE_IMMUTABLE';
  end if;
  if old.approval_status is distinct from new.approval_status
    and not(old.approval_status='PENDING' and new.approval_status in ('APPROVED','REJECTED')) then
    raise exception 'INVALID_EXECUTION_APPROVAL_TRANSITION';
  end if;
  if old.approval_status <> 'PENDING'
    and row(new.approver_user_id,new.decided_at,new.decision_reason)
      is distinct from row(old.approver_user_id,old.decided_at,old.decision_reason) then
    raise exception 'EXECUTION_APPROVAL_DECISION_IMMUTABLE';
  end if;
  if old.status is distinct from new.status and not(
    old.status='WAITING_APPROVAL' and new.status in ('READY','CANCELLED')
  ) then raise exception 'INVALID_EXECUTION_REQUEST_TRANSITION'; end if;
  return new;
end;
$guard$;
create trigger execution_request_update_guard before update on private.execution_requests
for each row execute function private.guard_execution_request_update();

-- Append-only decision evidence.
create or replace function private.reject_execution_decision_event_mutation()
returns trigger language plpgsql set search_path=pg_catalog as $immutable$
begin raise exception 'EXECUTION_DECISION_EVENTS_ARE_APPEND_ONLY'; end;
$immutable$;
create trigger execution_decision_events_no_update before update or delete
on private.execution_request_decision_events for each row
execute function private.reject_execution_decision_event_mutation();

-- Request creator: auth.uid() is both requester and executor; all security
-- relevant approval/risk fields are fixed by the database, not caller input.
create or replace function public.create_authenticated_execution_request(
  p_request_id text,p_task_id text,p_mission_id text,p_organization_id uuid,
  p_workspace_id uuid,p_capability text,p_action text,p_input jsonb,
  p_target_reference jsonb,p_idempotency_key text,p_input_digest text
) returns setof private.execution_requests
language plpgsql security definer set search_path=pg_catalog as $create$
declare v_actor uuid:=auth.uid(); v_row private.execution_requests%rowtype;
begin
  if v_actor is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='42501'; end if;
  if p_request_id is null or length(btrim(p_request_id)) not between 1 and 160
    or p_task_id is null or length(btrim(p_task_id)) not between 1 and 160
    or p_mission_id is null or length(btrim(p_mission_id)) not between 1 and 160
    or p_organization_id is null or p_workspace_id is null
    or p_capability is null or p_capability not in ('CODE','FILE','API','BROWSER','SHELL','DATABASE','AI','DEPLOYMENT','PUBLISH','AUTOMATION')
    or p_action is null or length(btrim(p_action)) not between 1 and 200
    or p_input is null or jsonb_typeof(p_input)<>'object'
    or(p_target_reference is not null and jsonb_typeof(p_target_reference)<>'object')
    or p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 160
    or p_input_digest is null or p_input_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_EXECUTION_ENVELOPE' using errcode='22023';
  end if;
  if p_target_reference is not null and (
    jsonb_typeof(p_target_reference->'token') is distinct from 'string'
    or length(btrim(p_target_reference->>'token'))=0
    or p_target_reference->>'entityType' is null
    or p_target_reference->>'entityType' not in ('PROJECT','MISSION','TASK','FILE','DATABASE')
    or jsonb_typeof(p_target_reference->'entityId') is distinct from 'string'
    or length(btrim(p_target_reference->>'entityId'))=0
    or p_target_reference->>'confidence' is null
    or p_target_reference->>'confidence' not in ('HIGH','MEDIUM','LOW','UNKNOWN')
    or p_target_reference->>'source' is null
    or p_target_reference->>'source' not in ('ACTIVE_CONTEXT','PERSISTED_MEMORY')
  ) then raise exception 'INVALID_TARGET_REFERENCE' using errcode='22023'; end if;

  -- Lock tenant rows/memberships in canonical order against concurrent revocation.
  perform 1 from private.organizations where organization_id=p_organization_id and status='ACTIVE' for share;
  if not found then raise exception 'TENANT_SCOPE_DENIED' using errcode='42501'; end if;
  perform 1 from private.workspaces where organization_id=p_organization_id and workspace_id=p_workspace_id and status='ACTIVE' for share;
  if not found then raise exception 'TENANT_SCOPE_DENIED' using errcode='42501'; end if;
  perform 1 from private.organization_memberships where organization_id=p_organization_id and user_id=v_actor and status='ACTIVE' for share;
  if not found then raise exception 'TENANT_SCOPE_DENIED' using errcode='42501'; end if;
  perform 1 from private.workspace_memberships where organization_id=p_organization_id and workspace_id=p_workspace_id and user_id=v_actor and status='ACTIVE' for share;
  if not found then raise exception 'TENANT_SCOPE_DENIED' using errcode='42501'; end if;

  insert into private.execution_requests(request_id,task_id,mission_id,requester_user_id,executor_user_id,
    organization_id,workspace_id,status,capability,action,input,target_reference,risk,requires_approval,
    approval_status,required_approval_role,idempotency_key,input_digest,attempt_count,created_at)
  values(btrim(p_request_id),btrim(p_task_id),btrim(p_mission_id),v_actor,v_actor,p_organization_id,p_workspace_id,
    'WAITING_APPROVAL',p_capability,btrim(p_action),p_input,p_target_reference,'HIGH',true,
    'PENDING','FOUNDER',btrim(p_idempotency_key),p_input_digest,0,clock_timestamp())
  on conflict(organization_id,workspace_id,requester_user_id,idempotency_key) do nothing;

  select r.* into v_row from private.execution_requests r
    where r.organization_id=p_organization_id and r.workspace_id=p_workspace_id
      and r.requester_user_id=v_actor and r.idempotency_key=btrim(p_idempotency_key) for share;
  if not found then raise exception 'EXECUTION_REQUEST_CREATE_FAILED'; end if;
  if v_row.task_id<>btrim(p_task_id)
    or v_row.mission_id<>btrim(p_mission_id) or v_row.capability<>p_capability
    or v_row.action<>btrim(p_action) or v_row.input<>p_input
    or v_row.target_reference is distinct from p_target_reference
    or v_row.input_digest<>p_input_digest then
    raise exception 'IDEMPOTENCY_KEY_REUSE_CONFLICT' using errcode='23505';
  end if;
  return next v_row;
end;
$create$;

-- Full immutable request envelope is returned only to its assigned executor.
create or replace function public.resolve_authenticated_execution_request(p_request_id text)
returns table(
  request_id text,task_id text,mission_id text,requester_user_id uuid,executor_user_id uuid,
  organization_id uuid,workspace_id uuid,capability text,action text,input jsonb,
  target_reference jsonb,requires_approval boolean,risk text,approval_status text,
  required_approval_role text,status text,input_digest text,created_at timestamptz
) language sql security definer set search_path=pg_catalog as $read$
 select r.request_id,r.task_id,r.mission_id,r.requester_user_id,r.executor_user_id,
  r.organization_id,r.workspace_id,r.capability,r.action,r.input,r.target_reference,
  r.requires_approval,r.risk,r.approval_status,r.required_approval_role,r.status,r.input_digest,r.created_at
 from private.execution_requests r
 where p_request_id is not null and r.request_id=p_request_id and r.executor_user_id=auth.uid()
 limit 1;
$read$;

-- Only a distinct, active FOUNDER can make the pending decision. Decision,
-- approver identity, timestamps, and evidence are committed atomically.
create or replace function public.decide_authenticated_execution_request(
  p_request_id text,p_decision text,p_reason text
) returns boolean language plpgsql security definer set search_path=pg_catalog as $decision$
declare v_actor uuid:=auth.uid(); v_scope record; v_request private.execution_requests%rowtype; v_now timestamptz:=clock_timestamp();
begin
 if v_actor is null then return false; end if;
 if p_decision not in ('APPROVED','REJECTED') or p_reason is null or length(btrim(p_reason)) not between 1 and 1000 then
  raise exception 'INVALID_EXECUTION_DECISION' using errcode='22023'; end if;
 select organization_id,workspace_id into v_scope from private.execution_requests where request_id=p_request_id;
 if not found then return false; end if;
 perform 1 from private.organizations where organization_id=v_scope.organization_id and status='ACTIVE' for share;
 if not found then return false; end if;
 perform 1 from private.workspaces where organization_id=v_scope.organization_id and workspace_id=v_scope.workspace_id and status='ACTIVE' for share;
 if not found then return false; end if;
 perform 1 from private.organization_memberships where organization_id=v_scope.organization_id and user_id=v_actor and status='ACTIVE' and role='FOUNDER' for share;
 if not found then return false; end if;
 perform 1 from private.workspace_memberships where organization_id=v_scope.organization_id and workspace_id=v_scope.workspace_id and user_id=v_actor and status='ACTIVE' and role in ('FOUNDER','ADMIN','OWNER') for share;
 if not found then return false; end if;
 select r.* into v_request from private.execution_requests r where r.request_id=p_request_id for update;
 if not found or v_request.status<>'WAITING_APPROVAL' or v_request.approval_status<>'PENDING'
   or v_request.requester_user_id=v_actor or v_request.executor_user_id=v_actor then return false; end if;
 update private.execution_requests set approval_status=p_decision,approver_user_id=v_actor,
   decided_at=v_now,decision_reason=btrim(p_reason),
   status=case when p_decision='APPROVED' then 'READY' else 'CANCELLED' end
 where request_id=p_request_id and status='WAITING_APPROVAL' and approval_status='PENDING';
 if not found then return false; end if;
 insert into private.execution_request_decision_events(request_id,actor_user_id,decision,reason,occurred_at)
 values(p_request_id,v_actor,p_decision,btrim(p_reason),v_now);
 return true;
end;
$decision$;

-- Separate owners: read-only lookup versus tightly scoped request/decision DML.
do $roles$
begin
 create role happy_execution_request_read_rpc_owner nologin bypassrls;
exception when duplicate_object then null;
end
$roles$;
do $roles$
begin
 create role happy_execution_request_write_rpc_owner nologin bypassrls;
exception when duplicate_object then null;
end
$roles$;
grant usage on schema private,auth to happy_execution_request_read_rpc_owner,happy_execution_request_write_rpc_owner;
grant select on private.execution_requests,private.organizations,private.workspaces,
 private.organization_memberships,private.workspace_memberships to happy_execution_request_read_rpc_owner;
grant select,insert,update on private.execution_requests to happy_execution_request_write_rpc_owner;
grant insert on private.execution_request_decision_events to happy_execution_request_write_rpc_owner;
grant select on private.organizations,private.workspaces,private.organization_memberships,
 private.workspace_memberships to happy_execution_request_write_rpc_owner;
grant execute on function auth.uid() to happy_execution_request_read_rpc_owner,happy_execution_request_write_rpc_owner;
do $role_check$
begin
 if not exists(select 1 from pg_roles where rolname='happy_execution_request_read_rpc_owner' and rolcanlogin=false and rolbypassrls=true)
   or not exists(select 1 from pg_roles where rolname='happy_execution_request_write_rpc_owner' and rolcanlogin=false and rolbypassrls=true) then
  raise exception 'execution request RPC owners must be NOLOGIN BYPASSRLS';
 end if;
end
$role_check$;

alter function public.resolve_authenticated_execution_request(text) owner to happy_execution_request_read_rpc_owner;
alter function public.create_authenticated_execution_request(text,text,text,uuid,uuid,text,text,jsonb,jsonb,text,text) owner to happy_execution_request_write_rpc_owner;
alter function public.decide_authenticated_execution_request(text,text,text) owner to happy_execution_request_write_rpc_owner;

revoke all on function public.resolve_authenticated_execution_request(text) from public,anon,service_role;
revoke all on function public.create_authenticated_execution_request(text,text,text,uuid,uuid,text,text,jsonb,jsonb,text,text) from public,anon,service_role;
revoke all on function public.decide_authenticated_execution_request(text,text,text) from public,anon,service_role;
grant execute on function public.resolve_authenticated_execution_request(text) to authenticated;
grant execute on function public.create_authenticated_execution_request(text,text,text,uuid,uuid,text,text,jsonb,jsonb,text,text) to authenticated;
grant execute on function public.decide_authenticated_execution_request(text,text,text) to authenticated;

revoke insert,update,delete on private.execution_requests from authenticated;
revoke insert,update,delete on private.execution_request_decision_events from authenticated;
