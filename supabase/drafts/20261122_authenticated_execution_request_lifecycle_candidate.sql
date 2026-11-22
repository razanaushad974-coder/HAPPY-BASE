-- DESIGN-ONLY execution request lifecycle candidate.
-- DO NOT APPLY to a connected/shared/production Supabase project.
-- Requires the private tenant identity tables and private.execution_requests
-- from 20261119_file_mutation_atomic_consume_candidate.sql, plus the existing
-- authenticated tenant-context and scheduler candidates.
--
-- This candidate persists the complete immutable execution envelope and its
-- approval decision. It intentionally grants no worker/scheduler RPC access.
-- Human request creation/approval and worker execution remain separate trust
-- domains. The later scheduler enqueue function must lock this exact row and
-- compare every immutable field before writing an outbox record.
--
-- Prerequisite: pgcrypto's digest(bytea,text) is installed in schema extensions.
-- The candidate fails closed if it is unavailable.

do $prerequisite$
begin
  if to_regprocedure('extensions.digest(bytea,text)') is null then
    raise exception 'pgcrypto extensions.digest(bytea,text) is required';
  end if;
end
$prerequisite$;

alter table private.execution_requests
  add column if not exists capability text,
  add column if not exists action text,
  add column if not exists input jsonb,
  add column if not exists target_reference jsonb,
  add column if not exists idempotency_key text,
  add column if not exists request_digest text,
  add column if not exists risk text,
  add column if not exists requires_approval boolean,
  add column if not exists approval_status text,
  add column if not exists approver_user_id uuid references auth.users(id) on delete restrict,
  add column if not exists decision_reason text,
  add column if not exists decided_at timestamptz,
  add column if not exists created_at timestamptz not null default clock_timestamp(),
  add column if not exists created_at_iso text;

-- Existing rows from the older minimal schema remain legacy/incomplete and
-- cannot pass the enqueue gate. Do not invent their missing envelope or approval.
update private.execution_requests
   set created_at_iso = to_char(
     date_trunc('milliseconds', created_at) at time zone 'UTC',
     'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
   )
 where created_at_iso is null;

alter table private.execution_requests
  drop constraint if exists execution_requests_status_check;
alter table private.execution_requests
  add constraint execution_requests_status_check
  check (status in ('PENDING_APPROVAL','READY','REJECTED','CANCELLED','COMPLETED'));

alter table private.execution_requests
  add constraint execution_requests_capability_check
    check (capability is null or capability in (
      'CODE','FILE','API','BROWSER','SHELL','DATABASE','AI',
      'DEPLOYMENT','PUBLISH','AUTOMATION'
    )),
  add constraint execution_requests_risk_check
    check (risk is null or risk in ('LOW','MEDIUM','HIGH','CRITICAL')),
  add constraint execution_requests_approval_status_check
    check (approval_status is null or approval_status in (
      'PENDING','APPROVED','REJECTED','REVOKED','EXPIRED'
    )),
  add constraint execution_requests_digest_check
    check (request_digest is null or request_digest ~ '^sha256:[a-f0-9]{64}$'),
  add constraint execution_requests_idempotency_key_check
    check (idempotency_key is null or length(btrim(idempotency_key)) between 1 and 200),
  add constraint execution_requests_envelope_shape_check
    check (
      (input is null or jsonb_typeof(input) = 'object')
      and (target_reference is null or jsonb_typeof(target_reference) = 'object')
    );

create unique index if not exists execution_requests_idempotency_unique
  on private.execution_requests (
    organization_id, workspace_id, requester_user_id, idempotency_key
  ) where idempotency_key is not null;

create index if not exists execution_requests_approval_scope_idx
  on private.execution_requests (organization_id, workspace_id, approval_status, created_at);

-- JSONB object keys are sorted explicitly using bytewise/C collation so this
-- representation matches the TypeScript canonical JSON serializer. Arrays
-- preserve their original order; scalars use JSON's canonical text form.
create or replace function private.happy_canonical_jsonb(p_value jsonb)
returns text
language plpgsql
immutable
strict
set search_path = pg_catalog
as $canonical$
declare
  v_type text := jsonb_typeof(p_value);
  v_result text;
begin
  if v_type = 'object' then
    select '{' || coalesce(string_agg(
      to_json(k.key)::text || ':' || private.happy_canonical_jsonb(k.value),
      ',' order by k.key collate "C"
    ), '') || '}'
      into v_result
      from jsonb_each(p_value) as k(key, value);
    return v_result;
  elsif v_type = 'array' then
    select '[' || coalesce(string_agg(
      private.happy_canonical_jsonb(a.value), ',' order by a.ordinality
    ), '') || ']'
      into v_result
      from jsonb_array_elements(p_value) with ordinality as a(value, ordinality);
    return v_result;
  elsif v_type = 'string' then
    return to_json(p_value #>> '{}')::text;
  else
    return p_value::text;
  end if;
end;
$canonical$;

revoke all on function private.happy_canonical_jsonb(jsonb)
  from public, anon, authenticated, service_role;

-- Envelope fields are immutable after insert. Only the decision lifecycle may
-- change approval_status/status/approver/reason/decided_at; callers cannot
-- replace task, tenant, actor, capability, action, input, target or digest.
create or replace function private.guard_execution_request_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $guard$
begin
  if row(
    new.request_id, new.task_id, new.mission_id, new.requester_user_id,
    new.executor_user_id, new.organization_id, new.workspace_id,
    new.capability, new.action, new.input, new.target_reference,
    new.idempotency_key, new.request_digest, new.risk,
    new.requires_approval, new.created_at, new.created_at_iso
  ) is distinct from row(
    old.request_id, old.task_id, old.mission_id, old.requester_user_id,
    old.executor_user_id, old.organization_id, old.workspace_id,
    old.capability, old.action, old.input, old.target_reference,
    old.idempotency_key, old.request_digest, old.risk,
    old.requires_approval, old.created_at, old.created_at_iso
  ) then
    raise exception 'EXECUTION_REQUEST_ENVELOPE_IMMUTABLE' using errcode = '55000';
  end if;

  if old.approval_status = 'PENDING'
     and new.approval_status in ('APPROVED','REJECTED')
     and new.status = case when new.approval_status = 'APPROVED' then 'READY' else 'REJECTED' end
     and new.approver_user_id is not null
     and new.approver_user_id <> old.requester_user_id
     and new.approver_user_id <> old.executor_user_id
     and new.decided_at is not null
     and length(btrim(coalesce(new.decision_reason,''))) > 0 then
    return new;
  end if;

  if old.approval_status = new.approval_status
     and old.status = new.status
     and row(new.approver_user_id,new.decision_reason,new.decided_at)
       is not distinct from row(old.approver_user_id,old.decision_reason,old.decided_at) then
    return new;
  end if;

  raise exception 'INVALID_EXECUTION_REQUEST_STATE_TRANSITION' using errcode = '55000';
end;
$guard$;

drop trigger if exists execution_request_immutable_guard on private.execution_requests;
create trigger execution_request_immutable_guard
before update on private.execution_requests
for each row execute function private.guard_execution_request_update();

-- Only the request-creation RPC may insert complete requests, always pending
-- approval. Legacy direct inserts are blocked by this trigger.
create or replace function private.guard_execution_request_insert()
returns trigger
language plpgsql
set search_path = pg_catalog
as $insert_guard$
begin
  if new.capability is null or new.action is null or length(btrim(new.action)) = 0
     or new.input is null or jsonb_typeof(new.input) <> 'object'
     or new.idempotency_key is null or new.request_digest is null
     or new.risk is null or new.requires_approval is distinct from true
     or new.approval_status is distinct from 'PENDING'
     or new.status is distinct from 'PENDING_APPROVAL'
     or new.approver_user_id is not null or new.decided_at is not null
     or new.decision_reason is not null or new.created_at_iso is null then
    raise exception 'EXECUTION_REQUEST_MUST_START_PENDING_WITH_COMPLETE_ENVELOPE';
  end if;
  return new;
end;
$insert_guard$;

drop trigger if exists execution_request_insert_guard on private.execution_requests;
create trigger execution_request_insert_guard
before insert on private.execution_requests
for each row execute function private.guard_execution_request_insert();

create or replace function public.create_authenticated_execution_request(
  p_request_id text,
  p_task_id text,
  p_mission_id text,
  p_organization_id uuid,
  p_workspace_id uuid,
  p_capability text,
  p_action text,
  p_input jsonb,
  p_target_reference jsonb,
  p_idempotency_key text
)
returns table (
  request_id text,
  task_id text,
  mission_id text,
  requester_user_id uuid,
  executor_user_id uuid,
  organization_id uuid,
  workspace_id uuid,
  capability text,
  action text,
  input jsonb,
  target_reference jsonb,
  idempotency_key text,
  request_digest text,
  risk text,
  requires_approval boolean,
  approval_status text,
  status text,
  created_at_iso text
)
language plpgsql
security definer
set search_path = pg_catalog
as $create$
declare
  v_actor uuid := auth.uid();
  v_mission jsonb;
  v_task jsonb;
  v_created_at timestamptz := date_trunc('milliseconds', clock_timestamp());
  v_created_at_iso text;
  v_envelope jsonb;
  v_digest text;
  v_existing private.execution_requests%rowtype;
begin
  if v_actor is null
     or p_request_id is null or length(btrim(p_request_id)) not between 1 and 200
     or p_task_id is null or length(btrim(p_task_id)) not between 1 and 200
     or p_mission_id is null or length(btrim(p_mission_id)) not between 1 and 200
     or p_organization_id is null or p_workspace_id is null
     or p_capability is null
     or p_capability not in ('CODE','FILE','API','BROWSER','SHELL','DATABASE','AI','DEPLOYMENT','PUBLISH','AUTOMATION')
     or p_action is null or length(btrim(p_action)) not between 1 and 200
     or p_input is null or jsonb_typeof(p_input) <> 'object'
     or pg_column_size(p_input) > 262144
     or (p_target_reference is not null and jsonb_typeof(p_target_reference) <> 'object')
     or p_idempotency_key is null or length(btrim(p_idempotency_key)) not between 1 and 200 then
    raise exception 'INVALID_EXECUTION_REQUEST_INPUT' using errcode = '22023';
  end if;

  if not exists (
    select 1
      from private.organizations o
      join private.workspaces w
        on w.organization_id = o.organization_id
       and w.workspace_id = p_workspace_id
      join private.organization_memberships om
        on om.organization_id = o.organization_id
       and om.user_id = v_actor and om.status = 'ACTIVE'
      join private.workspace_memberships wm
        on wm.organization_id = o.organization_id
       and wm.workspace_id = w.workspace_id
       and wm.user_id = v_actor and wm.status = 'ACTIVE'
     where o.organization_id = p_organization_id
       and o.status = 'ACTIVE' and w.status = 'ACTIVE'
  ) then
    raise exception 'TENANT_MEMBERSHIP_REQUIRED' using errcode = '42501';
  end if;

  select r.data into v_mission
    from public.happy_tenant_records r
   where r.organization_id = p_organization_id
     and r.workspace_id = p_workspace_id
     and r.user_id = v_actor
     and r.entity_type = 'MISSION'
     and r.record_id = p_mission_id
   for update;
  if not found or coalesce(v_mission->>'status','') not in ('READY','RUNNING','VERIFYING') then
    raise exception 'MISSION_NOT_ELIGIBLE' using errcode = '55000';
  end if;

  select r.data into v_task
    from public.happy_tenant_records r
   where r.organization_id = p_organization_id
     and r.workspace_id = p_workspace_id
     and r.user_id = v_actor
     and r.entity_type = 'TASK'
     and r.record_id = p_task_id
   for update;
  if not found
     or v_task->>'missionId' is distinct from p_mission_id
     or coalesce(v_task->>'status','') not in ('READY','RUNNING')
     or jsonb_typeof(v_mission->'taskIds') is distinct from 'array'
     or not ((v_mission->'taskIds') ? p_task_id) then
    raise exception 'TASK_NOT_ELIGIBLE' using errcode = '55000';
  end if;

  -- Requests are conservatively HIGH risk until the producer supplies a
  -- trusted risk classification. Every request requires a separate FOUNDER
  -- approval; approved is not a caller-controlled input.
  v_created_at_iso := to_char(
    v_created_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  v_envelope := jsonb_build_object(
    'requestId', p_request_id,
    'taskId', p_task_id,
    'missionId', p_mission_id,
    'organizationId', p_organization_id,
    'workspaceId', p_workspace_id,
    'requesterUserId', v_actor,
    'executorUserId', v_actor,
    'capability', p_capability,
    'action', p_action,
    'input', p_input,
    'targetReference', p_target_reference,
    'idempotencyKey', p_idempotency_key,
    'risk', 'HIGH',
    'requiresApproval', true,
    'createdAt', v_created_at_iso
  );
  v_digest := 'sha256:' || encode(
    extensions.digest(
      convert_to(private.happy_canonical_jsonb(v_envelope),'UTF8'),
      'sha256'
    ),
    'hex'
  );

  insert into private.execution_requests (
    request_id, task_id, mission_id, requester_user_id, executor_user_id,
    organization_id, workspace_id, status, capability, action, input,
    target_reference, idempotency_key, request_digest, risk,
    requires_approval, approval_status, created_at, created_at_iso
  ) values (
    p_request_id, p_task_id, p_mission_id, v_actor, v_actor,
    p_organization_id, p_workspace_id, 'PENDING_APPROVAL', p_capability,
    p_action, p_input, p_target_reference, p_idempotency_key, v_digest,
    'HIGH', true, 'PENDING', v_created_at, v_created_at_iso
  )
  on conflict do nothing;

  if not found then
    select * into v_existing
      from private.execution_requests r
     where r.organization_id = p_organization_id
       and r.workspace_id = p_workspace_id
       and r.requester_user_id = v_actor
       and r.idempotency_key = p_idempotency_key
     for update;
    if not found
       or v_existing.request_id <> p_request_id
       or v_existing.request_digest <> v_digest then
      raise exception 'EXECUTION_REQUEST_IDEMPOTENCY_MISMATCH' using errcode = '23505';
    end if;
  end if;

  return query
  select r.request_id,r.task_id,r.mission_id,r.requester_user_id,r.executor_user_id,
    r.organization_id,r.workspace_id,r.capability,r.action,r.input,r.target_reference,
    r.idempotency_key,r.request_digest,r.risk,r.requires_approval,r.approval_status,
    r.status,r.created_at_iso
  from private.execution_requests r
  where r.request_id = p_request_id
    and r.organization_id = p_organization_id
    and r.workspace_id = p_workspace_id
    and r.requester_user_id = v_actor;
end;
$create$;

create or replace function public.decide_authenticated_execution_request(
  p_request_id text,
  p_decision text,
  p_reason text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $decide$
declare
  v_actor uuid := auth.uid();
  v_request private.execution_requests%rowtype;
begin
  if v_actor is null
     or p_request_id is null or length(btrim(p_request_id)) = 0
     or p_decision is null
     or p_decision not in ('APPROVED','REJECTED')
     or p_reason is null or length(btrim(p_reason)) not between 1 and 2000 then
    raise exception 'INVALID_EXECUTION_REQUEST_DECISION' using errcode = '22023';
  end if;

  select * into v_request
    from private.execution_requests r
   where r.request_id = p_request_id
   for update;
  if not found then return false; end if;

  if v_request.requester_user_id = v_actor
     or v_request.executor_user_id = v_actor then
    raise exception 'SELF_APPROVAL_FORBIDDEN' using errcode = '42501';
  end if;

  if not exists (
    select 1
      from private.organizations o
      join private.workspaces w
        on w.organization_id = o.organization_id
       and w.workspace_id = v_request.workspace_id
       and w.status = 'ACTIVE'
      join private.organization_memberships om
        on om.organization_id = o.organization_id
       and om.user_id = v_actor
       and om.status = 'ACTIVE'
      join private.workspace_memberships wm
        on wm.organization_id = o.organization_id
       and wm.user_id = om.user_id
       and wm.workspace_id = w.workspace_id
       and wm.status = 'ACTIVE'
     where o.organization_id = v_request.organization_id
       and o.status = 'ACTIVE'
       and om.role = 'FOUNDER'
  ) then
    raise exception 'FOUNDER_APPROVAL_REQUIRED' using errcode = '42501';
  end if;

  if v_request.approval_status in ('APPROVED','REJECTED')
     and v_request.approver_user_id = v_actor
     and v_request.approval_status = p_decision
     and v_request.decision_reason = btrim(p_reason) then
    return true;
  end if;

  if v_request.status <> 'PENDING_APPROVAL'
     or v_request.approval_status <> 'PENDING'
     or v_request.requires_approval is distinct from true
     or v_request.request_digest is null
     or v_request.capability is null
     or v_request.input is null then
    raise exception 'EXECUTION_REQUEST_NOT_PENDING' using errcode = '55000';
  end if;

  update private.execution_requests
     set approval_status = p_decision,
         status = case when p_decision = 'APPROVED' then 'READY' else 'REJECTED' end,
         approver_user_id = v_actor,
         decision_reason = btrim(p_reason),
         decided_at = clock_timestamp()
   where request_id = p_request_id;

  return true;
end;
$decide$;

-- Dedicated NOLOGIN BYPASSRLS owner with narrow SELECT/INSERT/UPDATE
-- permissions. This is a human-session RPC owner, not a worker identity.
do $role$
begin
  create role happy_execution_request_lifecycle_owner nologin bypassrls;
exception when duplicate_object then null;
end
$role$;

grant usage on schema private, auth to happy_execution_request_lifecycle_owner;
grant select, insert, update on private.execution_requests
  to happy_execution_request_lifecycle_owner;
grant select on private.organizations, private.workspaces,
  private.organization_memberships, private.workspace_memberships,
  public.happy_tenant_records
  to happy_execution_request_lifecycle_owner;
grant execute on function auth.uid() to happy_execution_request_lifecycle_owner;
grant execute on function extensions.digest(bytea,text)
  to happy_execution_request_lifecycle_owner;
grant execute on function private.happy_canonical_jsonb(jsonb)
  to happy_execution_request_lifecycle_owner;

alter function public.create_authenticated_execution_request(
  text,text,text,uuid,uuid,text,text,jsonb,jsonb,text
) owner to happy_execution_request_lifecycle_owner;
alter function public.decide_authenticated_execution_request(text,text,text)
  owner to happy_execution_request_lifecycle_owner;

revoke all on function public.create_authenticated_execution_request(
  text,text,text,uuid,uuid,text,text,jsonb,jsonb,text
) from public, anon, service_role;
revoke all on function public.decide_authenticated_execution_request(text,text,text)
  from public, anon, service_role;
grant execute on function public.create_authenticated_execution_request(
  text,text,text,uuid,uuid,text,text,jsonb,jsonb,text
) to authenticated;
grant execute on function public.decide_authenticated_execution_request(text,text,text)
  to authenticated;

do $privileges$
begin
  if not exists (
    select 1 from pg_roles
     where rolname = 'happy_execution_request_lifecycle_owner'
       and rolcanlogin = false and rolbypassrls = true
  ) then
    raise exception 'execution request lifecycle owner must be NOLOGIN BYPASSRLS';
  end if;
  if not has_table_privilege('happy_execution_request_lifecycle_owner',
      'private.execution_requests', 'SELECT,INSERT,UPDATE')
     or has_table_privilege('happy_execution_request_lifecycle_owner',
      'private.execution_requests', 'DELETE') then
    raise exception 'execution request lifecycle owner privileges are invalid';
  end if;
  if not has_function_privilege('authenticated',
      'public.create_authenticated_execution_request(text,text,text,uuid,uuid,text,text,jsonb,jsonb,text)', 'EXECUTE')
     or not has_function_privilege('authenticated',
      'public.decide_authenticated_execution_request(text,text,text)', 'EXECUTE')
     or has_function_privilege('anon',
      'public.create_authenticated_execution_request(text,text,text,uuid,uuid,text,text,jsonb,jsonb,text)', 'EXECUTE')
     or has_function_privilege('anon',
      'public.decide_authenticated_execution_request(text,text,text)', 'EXECUTE')
     or has_function_privilege('service_role',
      'public.create_authenticated_execution_request(text,text,text,uuid,uuid,text,text,jsonb,jsonb,text)', 'EXECUTE')
     or has_function_privilege('service_role',
      'public.decide_authenticated_execution_request(text,text,text)', 'EXECUTE') then
    raise exception 'execution request lifecycle RPC grants are not least-privilege';
  end if;
end
$privileges$;

-- No grants are added to happy_claim_mission_task, happy_enqueue_mission_dispatch,
-- happy_claim_dispatch_outbox, heartbeat, outcome, or reconciliation RPCs.
-- The worker identity and persisted request/approval-to-outbox binding gates
-- must be implemented and tested independently before any worker grant exists.
