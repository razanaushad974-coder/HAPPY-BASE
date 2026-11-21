-- DESIGN-ONLY candidate. DO NOT APPLY to a connected Supabase project.
-- Depends on private.execution_requests and canonical private tenant tables from
-- 20261119_file_mutation_atomic_consume_candidate.sql.
-- Self-execution only: requester=executor=auth.uid(). Delegation is unsupported.
-- Approval-required requests stay WAITING_APPROVAL; no approval decision RPC is
-- implemented here, so they cannot be claimed. Expired RUNNING requests require
-- reconciliation and must never be automatically replayed.
-- Before deployment, review existing-row backfill, RLS/FORCE RLS, dedicated
-- NOLOGIN function owner, private schema grants, lock ordering, and real JWTs.

alter table private.execution_requests
  add column capability text, add column action text, add column input jsonb,
  add column target_reference jsonb, add column risk text,
  add column requires_approval boolean, add column approval_state text,
  add column idempotency_key text, add column input_digest text,
  add column result jsonb, add column lease_token uuid,
  add column lease_expires_at timestamptz,
  add column attempt_count integer not null default 0,
  add column created_at timestamptz not null default clock_timestamp(),
  add column started_at timestamptz, add column completed_at timestamptz;

do $legacy$
begin
  if exists(select 1 from private.execution_requests where capability is null or action is null
    or input is null or risk is null or requires_approval is null or approval_state is null
    or idempotency_key is null or input_digest is null) then
    raise exception 'LEGACY_EXECUTION_REQUESTS_REQUIRE_EXPLICIT_BACKFILL';
  end if;
end $legacy$;

alter table private.execution_requests
  alter column capability set not null, alter column action set not null,
  alter column input set not null, alter column risk set not null,
  alter column requires_approval set not null, alter column approval_state set not null,
  alter column idempotency_key set not null, alter column input_digest set not null,
  add constraint execution_requests_capability_check check
    (capability in ('CODE','FILE','API','BROWSER','SHELL','DATABASE','AI','DEPLOYMENT','PUBLISH','AUTOMATION')),
  add constraint execution_requests_action_check check(length(btrim(action)) between 1 and 200),
  add constraint execution_requests_input_check check(jsonb_typeof(input)='object'),
  add constraint execution_requests_target_check check(target_reference is null or jsonb_typeof(target_reference)='object'),
  add constraint execution_requests_risk_check check(risk in ('LOW','MEDIUM','HIGH','CRITICAL')),
  add constraint execution_requests_approval_check check(approval_state in ('NOT_REQUIRED','PENDING','APPROVED','REJECTED','REVOKED','EXPIRED')),
  add constraint execution_requests_idempotency_check check(length(btrim(idempotency_key)) between 1 and 160),
  add constraint execution_requests_digest_check check(input_digest ~ '^[0-9a-f]{64}$'),
  add constraint execution_requests_attempt_check check(attempt_count between 0 and 1),
  add constraint execution_requests_approval_consistency_check check
    ((not requires_approval and approval_state='NOT_REQUIRED') or (requires_approval and approval_state<>'NOT_REQUIRED')),
  add constraint execution_requests_lease_check check
    ((status='RUNNING' and lease_token is not null and lease_expires_at is not null and started_at is not null)
     or (status<>'RUNNING' and lease_token is null and lease_expires_at is null)),
  add constraint execution_requests_completed_check check
    ((status in ('COMPLETED','FAILED','BLOCKED','CANCELLED') and completed_at is not null)
     or (status not in ('COMPLETED','FAILED','BLOCKED','CANCELLED') and completed_at is null));

alter table private.execution_requests drop constraint if exists execution_requests_status_check,
  add constraint execution_requests_lifecycle_status_check
  check(status in ('WAITING_APPROVAL','READY','RUNNING','COMPLETED','FAILED','BLOCKED','CANCELLED'));

create unique index execution_requests_idempotency_scope_idx
  on private.execution_requests(organization_id,workspace_id,requester_user_id,idempotency_key);

create or replace function private.guard_execution_request_update()
returns trigger language plpgsql set search_path=pg_catalog as $guard$
begin
  if row(new.request_id,new.task_id,new.mission_id,new.requester_user_id,new.executor_user_id,
    new.organization_id,new.workspace_id,new.capability,new.action,new.input,new.target_reference,
    new.risk,new.requires_approval,new.idempotency_key,new.input_digest,new.created_at)
    is distinct from row(old.request_id,old.task_id,old.mission_id,old.requester_user_id,old.executor_user_id,
    old.organization_id,old.workspace_id,old.capability,old.action,old.input,old.target_reference,
    old.risk,old.requires_approval,old.idempotency_key,old.input_digest,old.created_at) then
    raise exception 'EXECUTION_REQUEST_ENVELOPE_IMMUTABLE';
  end if;
  if old.approval_state is distinct from new.approval_state
    and not(old.approval_state='PENDING' and new.approval_state in ('APPROVED','REJECTED','REVOKED','EXPIRED')) then
    raise exception 'INVALID_EXECUTION_APPROVAL_TRANSITION';
  end if;
  if old.status is distinct from new.status
    and not((old.status='READY' and new.status='RUNNING')
      or(old.status='RUNNING' and new.status in ('COMPLETED','FAILED','BLOCKED'))) then
    raise exception 'INVALID_EXECUTION_REQUEST_TRANSITION';
  end if;
  return new;
end;
$guard$;
create trigger execution_request_update_guard before update on private.execution_requests
for each row execute function private.guard_execution_request_update();

-- Creates an immutable envelope; principals are never caller parameters.
create or replace function public.create_authenticated_execution_request(
  p_organization_id uuid,p_workspace_id uuid,p_request_id text,p_task_id text,p_mission_id text,
  p_capability text,p_action text,p_input jsonb,p_target_reference jsonb,p_risk text,
  p_requires_approval boolean,p_idempotency_key text,p_input_digest text
) returns setof private.execution_requests
language plpgsql security definer set search_path=pg_catalog as $create$
declare v_actor uuid:=auth.uid(); v_row private.execution_requests%rowtype;
begin
  if v_actor is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='42501'; end if;
  if p_organization_id is null or p_workspace_id is null
    or p_request_id is null or length(btrim(p_request_id)) not between 1 and 160
    or p_task_id is null or length(btrim(p_task_id)) not between 1 and 160
    or p_mission_id is null or length(btrim(p_mission_id)) not between 1 and 160
    or p_capability not in ('CODE','FILE','API','BROWSER','SHELL','DATABASE','AI','DEPLOYMENT','PUBLISH','AUTOMATION')
    or p_action is null or length(btrim(p_action)) not between 1 and 200
    or p_input is null or jsonb_typeof(p_input)<>'object'
    or(p_target_reference is not null and jsonb_typeof(p_target_reference)<>'object')
    or p_risk not in ('LOW','MEDIUM','HIGH','CRITICAL') or p_requires_approval is null
    or p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 160
    or p_input_digest is null or p_input_digest !~ '^[0-9a-f]{64}$' then
    raise exception 'INVALID_EXECUTION_ENVELOPE' using errcode='22023';
  end if;
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
    approval_state,idempotency_key,input_digest)
  values(btrim(p_request_id),btrim(p_task_id),btrim(p_mission_id),v_actor,v_actor,p_organization_id,p_workspace_id,
    case when p_requires_approval then 'WAITING_APPROVAL' else 'READY' end,p_capability,btrim(p_action),
    p_input,p_target_reference,p_risk,p_requires_approval,
    case when p_requires_approval then 'PENDING' else 'NOT_REQUIRED' end,btrim(p_idempotency_key),p_input_digest)
  on conflict(organization_id,workspace_id,requester_user_id,idempotency_key) do nothing;
  select r.* into v_row from private.execution_requests r where r.organization_id=p_organization_id
    and r.workspace_id=p_workspace_id and r.requester_user_id=v_actor
    and r.idempotency_key=btrim(p_idempotency_key) for share;
  if not found then raise exception 'EXECUTION_REQUEST_CREATE_FAILED'; end if;
  if v_row.request_id<>btrim(p_request_id) or v_row.task_id<>btrim(p_task_id)
    or v_row.mission_id<>btrim(p_mission_id) or v_row.capability<>p_capability
    or v_row.action<>btrim(p_action) or v_row.input<>p_input
    or v_row.target_reference is distinct from p_target_reference or v_row.risk<>p_risk
    or v_row.requires_approval<>p_requires_approval or v_row.input_digest<>p_input_digest then
    raise exception 'IDEMPOTENCY_KEY_REUSE_CONFLICT' using errcode='23505';
  end if;
  return next v_row;
end;
$create$;

-- Returns the full persisted envelope only to its executor.
create or replace function public.resolve_authenticated_execution_request(p_request_id text)
returns setof private.execution_requests language sql security definer set search_path=pg_catalog as $read$
 select r.* from private.execution_requests r where p_request_id is not null
 and r.request_id=p_request_id and r.executor_user_id=auth.uid() limit 1;
$read$;

-- One-shot claim. PENDING approval cannot be claimed by this implementation.
create or replace function public.claim_authenticated_execution_request(p_request_id text,p_lease_seconds integer default 60)
returns table(request_id text,lease_token uuid,lease_expires_at timestamptz,capability text,
 action text,input jsonb,target_reference jsonb,risk text)
language plpgsql security definer set search_path=pg_catalog as $claim$
declare v_actor uuid:=auth.uid(); v_row private.execution_requests%rowtype; v_now timestamptz:=clock_timestamp();
begin
 if v_actor is null then raise exception 'AUTHENTICATION_REQUIRED' using errcode='42501'; end if;
 if p_lease_seconds is null or p_lease_seconds not between 5 and 300 then raise exception 'INVALID_EXECUTION_LEASE' using errcode='22023'; end if;
 select r.* into v_row from private.execution_requests r where r.request_id=p_request_id and r.executor_user_id=v_actor for update;
 if not found then raise exception 'EXECUTION_REQUEST_NOT_FOUND' using errcode='P0002'; end if;
 if v_row.status<>'READY' or v_row.approval_state<>'NOT_REQUIRED' or v_row.requires_approval or v_row.attempt_count<>0 then
  raise exception 'EXECUTION_REQUEST_NOT_CLAIMABLE' using errcode='55000'; end if;
 update private.execution_requests r set status='RUNNING',lease_token=gen_random_uuid(),
  lease_expires_at=v_now+make_interval(secs=>p_lease_seconds),started_at=v_now,attempt_count=1
  where r.request_id=p_request_id returning r.* into v_row;
 return query select v_row.request_id,v_row.lease_token,v_row.lease_expires_at,
  v_row.capability,v_row.action,v_row.input,v_row.target_reference,v_row.risk;
end;
$claim$;

create or replace function public.finish_authenticated_execution_request(
 p_request_id text,p_lease_token uuid,p_terminal_status text,p_result jsonb
) returns boolean language plpgsql security definer set search_path=pg_catalog as $finish$
declare v_actor uuid:=auth.uid(); v_now timestamptz:=clock_timestamp();
begin
 if v_actor is null then return false; end if;
 if p_terminal_status not in ('COMPLETED','FAILED','BLOCKED') or p_result is null or jsonb_typeof(p_result)<>'object' then
  raise exception 'INVALID_EXECUTION_RESULT' using errcode='22023'; end if;
 update private.execution_requests r set status=p_terminal_status,result=p_result,completed_at=v_now,
  lease_token=null,lease_expires_at=null where r.request_id=p_request_id and r.executor_user_id=v_actor
  and r.status='RUNNING' and r.lease_token=p_lease_token and r.lease_expires_at>v_now;
 return found;
end;
$finish$;

-- These grants are not sufficient by themselves: assign and verify a dedicated
-- least-privilege NOLOGIN function owner before any deployment.
revoke all on function public.create_authenticated_execution_request(uuid,uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,text,text) from public,anon,service_role;
revoke all on function public.resolve_authenticated_execution_request(text) from public,anon,service_role;
revoke all on function public.claim_authenticated_execution_request(text,integer) from public,anon,service_role;
revoke all on function public.finish_authenticated_execution_request(text,uuid,text,jsonb) from public,anon,service_role;
grant execute on function public.create_authenticated_execution_request(uuid,uuid,text,text,text,text,text,jsonb,jsonb,text,boolean,text,text) to authenticated;
grant execute on function public.resolve_authenticated_execution_request(text) to authenticated;
grant execute on function public.claim_authenticated_execution_request(text,integer) to authenticated;
grant execute on function public.finish_authenticated_execution_request(text,uuid,text,jsonb) to authenticated;
revoke insert,update,delete on private.execution_requests from authenticated;
