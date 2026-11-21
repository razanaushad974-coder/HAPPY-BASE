-- DESIGN-ONLY candidate. Do NOT apply to hosted/shared Supabase.
-- Depends on 20261119_file_mutation_atomic_consume_candidate.sql and
-- 20261121_authenticated_execution_request_rpc_candidate.sql.
-- This persists immutable intent only. It does not approve or dispatch work.

alter table private.execution_requests
  add column if not exists capability text,
  add column if not exists action text,
  add column if not exists input jsonb,
  add column if not exists target_reference jsonb,
  add column if not exists requires_approval boolean,
  add column if not exists risk text,
  add column if not exists approval_status text,
  add column if not exists required_approval_role text,
  add column if not exists input_digest text,
  add column if not exists idempotency_key text,
  add column if not exists created_at timestamptz not null default clock_timestamp(),
  add column if not exists decided_at timestamptz,
  add column if not exists decided_by uuid references auth.users(id) on delete restrict,
  add column if not exists decision_reason text;

alter table private.execution_requests drop constraint if exists execution_requests_status_check;
alter table private.execution_requests add constraint execution_requests_status_check
  check (status in ('RECEIVED','WAITING_APPROVAL','READY','RUNNING','COMPLETED','FAILED','BLOCKED','NOT_YET_CONNECTED','CANCELLED'));

alter table private.execution_requests add constraint execution_requests_envelope_check
  check (
    (capability is null and action is null and input is null and requires_approval is null and risk is null and approval_status is null and required_approval_role is null and input_digest is null and idempotency_key is null)
    or
    (capability is not null and capability in ('CODE','FILE','API','BROWSER','SHELL','DATABASE','AI','DEPLOYMENT','PUBLISH','AUTOMATION')
     and action is not null and length(btrim(action)) > 0
     and input is not null and jsonb_typeof(input) = 'object'
     and (target_reference is null or jsonb_typeof(target_reference) = 'object')
     and requires_approval is not null
     and risk is not null and risk in ('LOW','MEDIUM','HIGH','CRITICAL')
     and approval_status is not null and approval_status in ('NOT_REQUIRED','PENDING','APPROVED','REJECTED')
     and required_approval_role is not null and required_approval_role = 'FOUNDER'
     and input_digest is not null and input_digest ~ '^[0-9a-f]{64}$'
     and idempotency_key is not null and length(btrim(idempotency_key)) > 0)
  );

drop index if exists private.execution_requests_idempotency_idx;
do $idempotency_constraint$
begin
  if not exists (
    select 1 from pg_constraint
     where conrelid = 'private.execution_requests'::regclass
       and conname = 'execution_requests_idempotency_unique'
  ) then
    alter table private.execution_requests
      add constraint execution_requests_idempotency_unique
      unique (requester_user_id, organization_id, workspace_id, idempotency_key);
  end if;
end
$idempotency_constraint$;

create or replace function private.guard_execution_request_update()
returns trigger language plpgsql security definer set search_path = pg_catalog
as $guard$
begin
  if row(new.request_id,new.task_id,new.mission_id,new.requester_user_id,new.executor_user_id,
         new.organization_id,new.workspace_id,new.capability,new.action,new.input,
         new.target_reference,new.requires_approval,new.risk,new.required_approval_role,new.input_digest,
         new.idempotency_key,new.created_at)
     is distinct from
     row(old.request_id,old.task_id,old.mission_id,old.requester_user_id,old.executor_user_id,
         old.organization_id,old.workspace_id,old.capability,old.action,old.input,
         old.target_reference,old.requires_approval,old.risk,old.required_approval_role,old.input_digest,
         old.idempotency_key,old.created_at) then
    raise exception 'Execution request envelope is immutable';
  end if;
  if old.approval_status is distinct from new.approval_status then
    if old.approval_status <> 'PENDING' or new.approval_status not in ('APPROVED','REJECTED')
       or new.decided_at is null or new.decided_by is null
       or new.decision_reason is null or length(btrim(new.decision_reason)) = 0 then
      raise exception 'Invalid execution approval transition';
    end if;
  elsif row(new.decided_at,new.decided_by,new.decision_reason)
        is distinct from row(old.decided_at,old.decided_by,old.decision_reason) then
    raise exception 'Execution approval evidence is immutable';
  end if;
  if old.status = new.status then return new; end if;
  if (old.status = 'READY' and new.status in ('RUNNING','CANCELLED','NOT_YET_CONNECTED'))
     or (old.status = 'RUNNING' and new.status in ('COMPLETED','FAILED','BLOCKED','NOT_YET_CONNECTED'))
     or (old.status = 'WAITING_APPROVAL' and new.status in ('READY','CANCELLED')) then
    return new;
  end if;
  raise exception 'Invalid execution request state transition';
end;
$guard$;

drop trigger if exists execution_request_guard_update on private.execution_requests;
create trigger execution_request_guard_update before update on private.execution_requests
for each row execute function private.guard_execution_request_update();

-- Even privileged service_role inserts cannot mint pre-approved executable
-- envelopes. Legacy rows without an envelope remain non-executable.
create or replace function private.guard_execution_request_insert()
returns trigger language plpgsql set search_path = pg_catalog
as $insert_guard$
begin
  if new.capability is not null and (
    new.requester_user_id is distinct from new.executor_user_id
    or new.status <> 'WAITING_APPROVAL'
    or new.requires_approval is distinct from true
    or new.risk <> 'HIGH'
    or new.approval_status <> 'PENDING'
    or new.required_approval_role <> 'FOUNDER'
    or new.decided_at is not null
    or new.decided_by is not null
    or new.decision_reason is not null
  ) then
    raise exception 'Execution requests must start pending founder approval';
  end if;
  return new;
end;
$insert_guard$;

drop trigger if exists execution_request_guard_insert on private.execution_requests;
create trigger execution_request_guard_insert before insert on private.execution_requests
for each row execute function private.guard_execution_request_insert();

-- The user-JWT creation/decision RPCs are the only write paths for enveloped
-- requests. service_role cannot mutate or delete an existing request directly.
revoke update,delete on private.execution_requests from service_role;

-- First API version permits self-execution only. auth.uid() supplies both
-- requester and executor; delegation needs a separately reviewed policy.
create or replace function public.create_authenticated_execution_request(
  p_request_id text, p_task_id text, p_mission_id text,
  p_organization_id uuid, p_workspace_id uuid,
  p_capability text, p_action text, p_input jsonb, p_target_reference jsonb,
  p_idempotency_key text
)
returns table (
  request_id text, task_id text, mission_id text,
  requester_user_id uuid, executor_user_id uuid,
  organization_id uuid, workspace_id uuid,
  capability text, action text, input jsonb, target_reference jsonb,
  requires_approval boolean, risk text, approval_status text, required_approval_role text,
  status text, input_digest text, created_at timestamptz
)
language plpgsql security definer set search_path = pg_catalog
as $function$
declare
  v_uid uuid := auth.uid();
  v_digest text;
  v_existing private.execution_requests%rowtype;
begin
  if v_uid is null or p_request_id is null or length(btrim(p_request_id)) = 0
     or p_task_id is null or length(btrim(p_task_id)) = 0
     or p_mission_id is null or length(btrim(p_mission_id)) = 0
     or p_organization_id is null or p_workspace_id is null
     or p_capability not in ('CODE','FILE','API','BROWSER','SHELL','DATABASE','AI','DEPLOYMENT','PUBLISH','AUTOMATION')
     or p_action is null or length(btrim(p_action)) = 0
     or p_input is null or jsonb_typeof(p_input) <> 'object'
     or (p_target_reference is not null and (
       jsonb_typeof(p_target_reference) <> 'object'
       or not (p_target_reference ?& array['token','entityType','entityId','confidence','source'])
       or coalesce(p_target_reference->>'token','') = ''
       or coalesce(p_target_reference->>'entityId','') = ''
       or coalesce(p_target_reference->>'entityType','') not in ('PROJECT','MISSION','TASK','FILE','DATABASE')
       or coalesce(p_target_reference->>'confidence','') not in ('HIGH','MEDIUM','LOW','UNKNOWN')
       or coalesce(p_target_reference->>'source','') not in ('ACTIVE_CONTEXT','PERSISTED_MEMORY')
     ))
     or p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0
     or length(p_request_id) > 160 or length(p_task_id) > 160
     or length(p_mission_id) > 160 or length(p_action) > 240
     or length(p_idempotency_key) > 160 then
    raise exception 'INVALID_EXECUTION_REQUEST';
  end if;

  if not exists (
    select 1 from private.organization_memberships om
    join private.workspace_memberships wm
      on wm.organization_id = om.organization_id and wm.user_id = om.user_id
    where om.user_id = v_uid and om.organization_id = p_organization_id
      and om.status = 'ACTIVE' and wm.workspace_id = p_workspace_id and wm.status = 'ACTIVE'
  ) then raise exception 'TENANT_ACCESS_DENIED'; end if;

  v_digest := encode(extensions.digest(convert_to(p_input::text,'UTF8'),'sha256'),'hex');

  insert into private.execution_requests(
    request_id,task_id,mission_id,requester_user_id,executor_user_id,
    organization_id,workspace_id,status,capability,action,input,target_reference,
    requires_approval,risk,approval_status,required_approval_role,input_digest,idempotency_key
  ) values (
    p_request_id,p_task_id,p_mission_id,v_uid,v_uid,p_organization_id,p_workspace_id,
    'WAITING_APPROVAL', p_capability,p_action,p_input,p_target_reference,true,'HIGH',
    'PENDING','FOUNDER',v_digest,p_idempotency_key
  )
  on conflict on constraint execution_requests_idempotency_unique do nothing;

  select r.* into v_existing from private.execution_requests r
   where r.requester_user_id=v_uid and r.organization_id=p_organization_id
     and r.workspace_id=p_workspace_id and r.idempotency_key=p_idempotency_key
   for update;
  if not found then raise exception 'EXECUTION_REQUEST_PERSISTENCE_FAILED'; end if;
  if v_existing.executor_user_id <> v_uid or v_existing.task_id <> p_task_id
     or v_existing.mission_id <> p_mission_id or v_existing.capability <> p_capability
     or v_existing.action <> p_action or v_existing.input <> p_input
     or v_existing.target_reference is distinct from p_target_reference
     or v_existing.requires_approval is distinct from true or v_existing.risk <> 'HIGH'
     or v_existing.required_approval_role <> 'FOUNDER'
     or v_existing.input_digest <> v_digest then
    raise exception 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_EXECUTION';
  end if;

  return query select r.request_id,r.task_id,r.mission_id,r.requester_user_id,r.executor_user_id,
    r.organization_id,r.workspace_id,r.capability,r.action,r.input,r.target_reference,
    r.requires_approval,r.risk,r.approval_status,r.required_approval_role,r.status,r.input_digest,r.created_at
    from private.execution_requests r where r.request_id=v_existing.request_id;
end;
$function$;

drop function if exists public.resolve_authenticated_execution_request(text);
create function public.resolve_authenticated_execution_request(p_request_id text)
returns table (
  request_id text, task_id text, mission_id text,
  requester_user_id uuid, executor_user_id uuid,
  organization_id uuid, workspace_id uuid,
  capability text, action text, input jsonb, target_reference jsonb,
  requires_approval boolean, risk text, approval_status text, required_approval_role text,
  status text, input_digest text, created_at timestamptz
)
language sql security definer set search_path = pg_catalog
as $function$
  select r.request_id,r.task_id,r.mission_id,r.requester_user_id,r.executor_user_id,
    r.organization_id,r.workspace_id,r.capability,r.action,r.input,r.target_reference,
    r.requires_approval,r.risk,r.approval_status,r.required_approval_role,r.status,r.input_digest,r.created_at
  from private.execution_requests r
  where p_request_id is not null and length(btrim(p_request_id)) > 0
    and r.request_id=p_request_id and r.executor_user_id=auth.uid()
    and r.capability is not null
  limit 1;
$function$;

do $role$
begin
  create role happy_execution_request_create_rpc_owner nologin bypassrls;
exception when duplicate_object then null;
end
$role$;
grant usage on schema private,auth,extensions to happy_execution_request_create_rpc_owner;
grant select,insert on private.execution_requests to happy_execution_request_create_rpc_owner;
grant select on private.organization_memberships,private.workspace_memberships to happy_execution_request_create_rpc_owner;
grant execute on function auth.uid() to happy_execution_request_create_rpc_owner;
grant execute on function extensions.digest(bytea,text) to happy_execution_request_create_rpc_owner;

alter function public.create_authenticated_execution_request(text,text,text,uuid,uuid,text,text,jsonb,jsonb,text)
  owner to happy_execution_request_create_rpc_owner;
alter function public.resolve_authenticated_execution_request(text)
  owner to happy_execution_request_create_rpc_owner;

revoke all on function public.create_authenticated_execution_request(text,text,text,uuid,uuid,text,text,jsonb,jsonb,text) from public,anon,service_role;
grant execute on function public.create_authenticated_execution_request(text,text,text,uuid,uuid,text,text,jsonb,jsonb,text) to authenticated;
revoke all on function public.resolve_authenticated_execution_request(text) from public,anon,service_role;
grant execute on function public.resolve_authenticated_execution_request(text) to authenticated;

-- Authenticated founder decision. The database derives the approver from
-- auth.uid(), locks the exact tenant/request/membership rows, forbids self
-- approval, and atomically changes approval + request state.
create or replace function public.decide_authenticated_execution_request(
  p_request_id text,
  p_decision text,
  p_reason text
)
returns boolean
language plpgsql security definer set search_path = pg_catalog
as $decision$
declare
  v_approver uuid := auth.uid();
  v_request private.execution_requests%rowtype;
  v_org private.organizations%rowtype;
  v_workspace private.workspaces%rowtype;
  v_member private.organization_memberships%rowtype;
  v_workspace_member private.workspace_memberships%rowtype;
  v_approver_org_role text;
  v_requester_org_active boolean := false;
  v_approver_org_active boolean := false;
  v_requester_workspace_active boolean := false;
  v_approver_workspace_active boolean := false;
begin
  if v_approver is null or p_request_id is null or length(btrim(p_request_id)) = 0
     or p_decision is null or p_decision not in ('APPROVED','REJECTED')
     or p_reason is null or length(btrim(p_reason)) = 0 or length(p_reason) > 1000 then
    return false;
  end if;

  select o.* into v_org
    from private.organizations o
    join private.execution_requests r on r.organization_id = o.organization_id
   where r.request_id = p_request_id
   for update of o;
  if not found or v_org.status <> 'ACTIVE' then return false; end if;

  select w.* into v_workspace
    from private.workspaces w
    join private.execution_requests r
      on r.organization_id = w.organization_id and r.workspace_id = w.workspace_id
   where r.request_id = p_request_id
   for update of w;
  if not found or v_workspace.status <> 'ACTIVE' then return false; end if;

  select r.* into v_request
    from private.execution_requests r
   where r.request_id = p_request_id
   for update;
  if not found or v_request.status <> 'WAITING_APPROVAL'
     or v_request.approval_status <> 'PENDING'
     or v_request.required_approval_role <> 'FOUNDER'
     or v_request.requires_approval is distinct from true
     or v_request.requester_user_id = v_approver then
    return false;
  end if;

  for v_member in
    select om.* from private.organization_memberships om
     where om.organization_id = v_request.organization_id
       and om.user_id in (v_request.requester_user_id, v_approver)
     order by om.user_id
     for update
  loop
    if v_member.user_id = v_request.requester_user_id then
      v_requester_org_active := v_member.status = 'ACTIVE';
    elsif v_member.user_id = v_approver then
      v_approver_org_active := v_member.status = 'ACTIVE';
      v_approver_org_role := v_member.role;
    end if;
  end loop;

  if not v_requester_org_active or not v_approver_org_active
     or v_approver_org_role <> 'FOUNDER' then
    return false;
  end if;

  for v_workspace_member in
    select wm.* from private.workspace_memberships wm
     where wm.organization_id = v_request.organization_id
       and wm.workspace_id = v_request.workspace_id
       and wm.user_id in (v_request.requester_user_id, v_approver)
     order by wm.user_id
     for update
  loop
    if v_workspace_member.user_id = v_request.requester_user_id then
      v_requester_workspace_active := v_workspace_member.status = 'ACTIVE';
    elsif v_workspace_member.user_id = v_approver then
      v_approver_workspace_active := v_workspace_member.status = 'ACTIVE';
    end if;
  end loop;

  if not v_requester_workspace_active or not v_approver_workspace_active then
    return false;
  end if;

  update private.execution_requests
     set approval_status = p_decision,
         decided_at = clock_timestamp(),
         decided_by = v_approver,
         decision_reason = btrim(p_reason),
         status = case when p_decision = 'APPROVED' then 'READY' else 'CANCELLED' end
   where request_id = p_request_id
     and approval_status = 'PENDING'
     and status = 'WAITING_APPROVAL';
  return found;
end;
$decision$;

do $role$
begin
  create role happy_execution_request_decision_rpc_owner nologin bypassrls;
exception when duplicate_object then null;
end
$role$;
grant usage on schema private,auth to happy_execution_request_decision_rpc_owner;
grant select,update on private.execution_requests to happy_execution_request_decision_rpc_owner;
grant select,update on private.organizations,private.workspaces,
  private.organization_memberships,private.workspace_memberships
  to happy_execution_request_decision_rpc_owner;
grant execute on function auth.uid() to happy_execution_request_decision_rpc_owner;
alter function public.decide_authenticated_execution_request(text,text,text)
  owner to happy_execution_request_decision_rpc_owner;
revoke all on function public.decide_authenticated_execution_request(text,text,text)
  from public,anon,service_role;
grant execute on function public.decide_authenticated_execution_request(text,text,text)
  to authenticated;

-- Remaining blockers before route dispatch: implement READY->RUNNING atomic
-- claim/fencing, durable outcome/evidence, and crash/recovery reconciliation.
-- This draft does not create those capabilities.
