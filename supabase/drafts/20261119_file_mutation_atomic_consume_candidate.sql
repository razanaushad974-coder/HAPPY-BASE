-- DESIGN-ONLY migration candidate. Never apply to a connected/shared Supabase project.
-- Requires a user-scoped Supabase JWT: auth.uid() is the executor identity.
-- The caller cannot pass requester, executor, or approver identities as parameters.

create schema if not exists private;

create table private.organizations (
  organization_id uuid primary key,
  status text not null check (status in ('ACTIVE','SUSPENDED','REVOKED'))
);

create table private.workspaces (
  workspace_id uuid primary key,
  organization_id uuid not null references private.organizations(organization_id) on delete restrict,
  status text not null check (status in ('ACTIVE','SUSPENDED','REVOKED')),
  unique (organization_id, workspace_id)
);

create table private.organization_memberships (
  organization_id uuid not null references private.organizations(organization_id) on delete restrict,
  user_id uuid not null references auth.users(id) on delete restrict,
  status text not null check (status in ('ACTIVE','SUSPENDED','REVOKED')),
  role text not null,
  primary key (organization_id, user_id)
);

create table private.workspace_memberships (
  organization_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null references auth.users(id) on delete restrict,
  status text not null check (status in ('ACTIVE','SUSPENDED','REVOKED')),
  role text not null,
  primary key (organization_id, workspace_id, user_id),
  foreign key (organization_id, workspace_id)
    references private.workspaces(organization_id, workspace_id) on delete restrict
);

create table private.execution_requests (
  request_id text primary key,
  task_id text not null,
  mission_id text not null,
  requester_user_id uuid not null references auth.users(id) on delete restrict,
  executor_user_id uuid not null references auth.users(id) on delete restrict,
  organization_id uuid not null references private.organizations(organization_id) on delete restrict,
  workspace_id uuid not null,
  status text not null check (status in ('READY','CANCELLED','COMPLETED')),
  foreign key (organization_id, workspace_id)
    references private.workspaces(organization_id, workspace_id) on delete restrict
);

create table private.file_mutation_approval_grants (
  grant_id uuid primary key,
  request_id text not null references private.execution_requests(request_id) on delete restrict,
  task_id text not null,
  mission_id text not null,
  requester_user_id uuid not null references auth.users(id) on delete restrict,
  executor_user_id uuid not null references auth.users(id) on delete restrict,
  approver_user_id uuid not null references auth.users(id) on delete restrict,
  organization_id uuid not null,
  workspace_id uuid not null,
  target_entity_type text not null check (target_entity_type = 'FILE'),
  target_entity_id text not null,
  operation text not null check (operation in ('CREATE','MODIFY','COPY','MOVE','RENAME','DELETE')),
  source_path text not null,
  destination_path text,
  input_digest text not null check (input_digest ~ '^[0-9a-f]{64}$'),
  required_role text not null check (required_role in ('FOUNDER','ADMIN')),
  status text not null check (status in ('PENDING','APPROVED','REJECTED','REVOKED','EXPIRED','CONSUMED')),
  expires_at timestamptz not null,
  decided_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz not null default clock_timestamp(),
  constraint file_grant_no_self_approval check (requester_user_id <> approver_user_id),
  constraint file_grant_decision_consistency check (
    (status = 'PENDING' and decided_at is null) or
    (status in ('APPROVED','REJECTED','REVOKED','EXPIRED','CONSUMED') and decided_at is not null)
  ),
  constraint file_grant_consumption_consistency check (
    (status = 'CONSUMED' and consumed_at is not null) or
    (status <> 'CONSUMED' and consumed_at is null)
  ),
  foreign key (organization_id, workspace_id)
    references private.workspaces(organization_id, workspace_id) on delete restrict
);

create table private.file_mutation_approval_events (
  event_id uuid primary key default gen_random_uuid(),
  grant_id uuid not null references private.file_mutation_approval_grants(grant_id) on delete restrict,
  actor_user_id uuid not null references auth.users(id) on delete restrict,
  event_type text not null check (event_type in ('CONSUMED')),
  occurred_at timestamptz not null,
  unique (grant_id, event_type)
);

-- Immutable approval binding and monotonic state transitions. The only
-- APPROVED -> CONSUMED path is the transactional SECURITY DEFINER RPC below.
create or replace function private.guard_file_mutation_grant_update()
returns trigger
language plpgsql
security definer
set search_path = pg_catalog
as $guard$
begin
  if row(
    new.request_id, new.task_id, new.mission_id, new.requester_user_id,
    new.executor_user_id, new.approver_user_id, new.organization_id,
    new.workspace_id, new.target_entity_type, new.target_entity_id,
    new.operation, new.source_path, new.destination_path, new.input_digest,
    new.required_role, new.expires_at, new.created_at
  ) is distinct from row(
    old.request_id, old.task_id, old.mission_id, old.requester_user_id,
    old.executor_user_id, old.approver_user_id, old.organization_id,
    old.workspace_id, old.target_entity_type, old.target_entity_id,
    old.operation, old.source_path, old.destination_path, old.input_digest,
    old.required_role, old.expires_at, old.created_at
  ) then
    raise exception 'FILE approval grant binding is immutable';
  end if;

  if old.status <> 'PENDING'
     and new.decided_at is distinct from old.decided_at then
    raise exception 'FILE approval decision timestamp is immutable';
  end if;

  if old.status = 'PENDING'
     and new.status in ('APPROVED','REJECTED','REVOKED','EXPIRED')
     and new.decided_at is not null
     and new.consumed_at is null then
    return new;
  end if;

  if old.status = 'APPROVED'
     and new.status in ('REVOKED','EXPIRED')
     and new.decided_at is not null
     and new.consumed_at is null then
    return new;
  end if;

  if old.status = 'APPROVED'
     and new.status = 'CONSUMED'
     and new.decided_at is not null
     and new.consumed_at is not null then
    return new;
  end if;

  raise exception 'Invalid FILE approval grant state transition';
end;
$guard$;

create or replace function private.guard_file_mutation_grant_insert()
returns trigger
language plpgsql
set search_path = pg_catalog
as $insert_guard$
begin
  if new.status <> 'PENDING'
     or new.decided_at is not null
     or new.consumed_at is not null then
    raise exception 'FILE approval grants must be created in PENDING state';
  end if;
  return new;
end;
$insert_guard$;

create trigger file_mutation_grant_guard_insert
before insert on private.file_mutation_approval_grants
for each row execute function private.guard_file_mutation_grant_insert();

create trigger file_mutation_grant_guard_update
before update on private.file_mutation_approval_grants
for each row execute function private.guard_file_mutation_grant_update();

create index file_grants_scope_request_idx
  on private.file_mutation_approval_grants (organization_id, workspace_id, request_id);
create index file_grants_scope_status_expiry_idx
  on private.file_mutation_approval_grants (organization_id, workspace_id, status, expires_at);

alter table private.organizations enable row level security;
alter table private.workspaces enable row level security;
alter table private.organization_memberships enable row level security;
alter table private.workspace_memberships enable row level security;
alter table private.execution_requests enable row level security;
alter table private.file_mutation_approval_grants enable row level security;
alter table private.file_mutation_approval_events enable row level security;

revoke all on schema private from public, anon, authenticated;
revoke all on all tables in schema private from public, anon, authenticated;
grant usage on schema private to service_role;
grant select, insert, update on private.organizations, private.workspaces,
  private.organization_memberships, private.workspace_memberships,
  private.execution_requests to service_role;
grant select, insert on private.file_mutation_approval_grants,
  private.file_mutation_approval_events to service_role;

create or replace function public.consume_file_mutation_approval_grant(
  p_grant_id uuid,
  p_organization_id uuid,
  p_workspace_id uuid,
  p_request_id text,
  p_task_id text,
  p_mission_id text,
  p_target_entity_id text,
  p_operation text,
  p_source_path text,
  p_destination_path text,
  p_input_digest text
)
returns boolean
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_executor_user_id uuid;
  v_approver_user_id uuid;
  v_request private.execution_requests%rowtype;
  v_organization private.organizations%rowtype;
  v_workspace private.workspaces%rowtype;
  v_executor_org private.organization_memberships%rowtype;
  v_approver_org private.organization_memberships%rowtype;
  v_executor_workspace private.workspace_memberships%rowtype;
  v_grant private.file_mutation_approval_grants%rowtype;
  v_member private.organization_memberships%rowtype;
  v_now timestamptz;
begin
  -- The authenticated JWT subject is the only source of executor identity.
  v_executor_user_id := auth.uid();
  if v_executor_user_id is null then
    return false;
  end if;

  if p_grant_id is null or p_organization_id is null or p_workspace_id is null
     or p_request_id is null or p_task_id is null or p_mission_id is null
     or p_target_entity_id is null or p_operation is null or p_source_path is null
     or p_input_digest is null
     or p_operation not in ('CREATE','MODIFY','COPY','MOVE','RENAME','DELETE')
     or p_input_digest !~ '^[0-9a-f]{64}$' then
    return false;
  end if;

  -- Non-locking hint read only to discover the approver ID for deterministic
  -- membership lock ordering. The locked grant is re-read and fully checked.
  select g.approver_user_id
    into v_approver_user_id
    from private.file_mutation_approval_grants g
   where g.grant_id = p_grant_id
     and g.organization_id = p_organization_id
     and g.workspace_id = p_workspace_id;
  if not found or v_approver_user_id is null then
    return false;
  end if;

  -- Global lock order: organization -> workspace -> execution request ->
  -- organization memberships ordered by user UUID -> executor workspace
  -- membership -> grant. Revocation/demotion updates the same membership row.
  select o.* into v_organization
    from private.organizations o
   where o.organization_id = p_organization_id
   for update;
  if not found or v_organization.status <> 'ACTIVE' then return false; end if;

  select w.* into v_workspace
    from private.workspaces w
   where w.organization_id = p_organization_id
     and w.workspace_id = p_workspace_id
   for update;
  if not found or v_workspace.status <> 'ACTIVE' then return false; end if;

  select r.* into v_request
    from private.execution_requests r
   where r.request_id = p_request_id
   for update;
  if not found
     or v_request.status <> 'READY'
     or v_request.organization_id is distinct from p_organization_id
     or v_request.workspace_id is distinct from p_workspace_id
     or v_request.task_id is distinct from p_task_id
     or v_request.mission_id is distinct from p_mission_id
     or v_request.executor_user_id is distinct from v_executor_user_id then
    return false;
  end if;

  for v_member in
    select m.*
      from private.organization_memberships m
     where m.organization_id = p_organization_id
       and m.user_id in (v_executor_user_id, v_approver_user_id)
     order by m.user_id
     for update
  loop
    if v_member.user_id = v_executor_user_id then
      v_executor_org := v_member;
    end if;
    if v_member.user_id = v_approver_user_id then
      v_approver_org := v_member;
    end if;
  end loop;

  if v_executor_org.user_id is null
     or v_executor_org.status <> 'ACTIVE'
     or v_approver_org.user_id is null
     or v_approver_org.status <> 'ACTIVE' then
    return false;
  end if;

  -- Explicit role policy: FOUNDER is required for FOUNDER grants; ADMIN grants
  -- accept only the explicit FOUNDER/ADMIN allowlist. No lexical hierarchy.
  select wm.* into v_executor_workspace
    from private.workspace_memberships wm
   where wm.organization_id = p_organization_id
     and wm.workspace_id = p_workspace_id
     and wm.user_id = v_executor_user_id
   for update;
  if not found or v_executor_workspace.status <> 'ACTIVE' then return false; end if;

  select g.* into v_grant
    from private.file_mutation_approval_grants g
   where g.grant_id = p_grant_id
   for update;
  v_now := clock_timestamp();
  if not found
     or v_grant.status <> 'APPROVED'
     or v_grant.consumed_at is not null
     or v_grant.decided_at is null
     or v_grant.expires_at <= v_now
     or v_grant.organization_id is distinct from p_organization_id
     or v_grant.workspace_id is distinct from p_workspace_id
     or v_grant.request_id is distinct from p_request_id
     or v_grant.task_id is distinct from p_task_id
     or v_grant.mission_id is distinct from p_mission_id
     or v_grant.requester_user_id is distinct from v_request.requester_user_id
     or v_grant.executor_user_id is distinct from v_executor_user_id
     or v_grant.approver_user_id is distinct from v_approver_user_id
     or v_grant.target_entity_type is distinct from 'FILE'
     or v_grant.target_entity_id is distinct from p_target_entity_id
     or v_grant.operation is distinct from p_operation
     or v_grant.source_path is distinct from p_source_path
     or v_grant.destination_path is distinct from p_destination_path
     or v_grant.input_digest is distinct from p_input_digest
     or (v_grant.required_role = 'FOUNDER' and v_approver_org.role <> 'FOUNDER')
     or (v_grant.required_role = 'ADMIN' and v_approver_org.role not in ('FOUNDER','ADMIN')) then
    return false;
  end if;

  update private.file_mutation_approval_grants
     set status = 'CONSUMED',
         consumed_at = v_now
   where grant_id = p_grant_id
     and status = 'APPROVED'
     and consumed_at is null
     and expires_at > v_now;
  if not found then return false; end if;

  insert into private.file_mutation_approval_events
    (grant_id, actor_user_id, event_type, occurred_at)
  values
    (p_grant_id, v_executor_user_id, 'CONSUMED', v_now);

  return true;
end;
$function$;

revoke all on function public.consume_file_mutation_approval_grant(
  uuid,uuid,uuid,text,text,text,text,text,text,text,text
) from public, anon, service_role;
grant execute on function public.consume_file_mutation_approval_grant(
  uuid,uuid,uuid,text,text,text,text,text,text,text,text
) to authenticated;
 then
    return false;
  end if;

  -- Non-locking hint read only to discover the approver ID for deterministic
  -- membership lock ordering. The locked grant is re-read and fully checked.
  select g.approver_user_id
    into v_approver_user_id
    from private.file_mutation_approval_grants g
   where g.grant_id = p_grant_id
     and g.organization_id = p_organization_id
     and g.workspace_id = p_workspace_id;
  if not found or v_approver_user_id is null then
    return false;
  end if;

  -- Global lock order: organization -> workspace -> execution request ->
  -- organization memberships ordered by user UUID -> executor workspace
  -- membership -> grant. Revocation/demotion updates the same membership row.
  select o.* into v_organization
    from private.organizations o
   where o.organization_id = p_organization_id
   for update;
  if not found or v_organization.status <> 'ACTIVE' then return false; end if;

  select w.* into v_workspace
    from private.workspaces w
   where w.organization_id = p_organization_id
     and w.workspace_id = p_workspace_id
   for update;
  if not found or v_workspace.status <> 'ACTIVE' then return false; end if;

  select r.* into v_request
    from private.execution_requests r
   where r.request_id = p_request_id
   for update;
  if not found
     or v_request.status <> 'READY'
     or v_request.organization_id <> p_organization_id
     or v_request.workspace_id <> p_workspace_id
     or v_request.task_id <> p_task_id
     or v_request.mission_id <> p_mission_id
     or v_request.executor_user_id <> v_executor_user_id then
    return false;
  end if;

  for v_member in
    select m.*
      from private.organization_memberships m
     where m.organization_id = p_organization_id
       and m.user_id in (v_executor_user_id, v_approver_user_id)
     order by m.user_id
     for update
  loop
    if v_member.user_id = v_executor_user_id then
      v_executor_org := v_member;
    end if;
    if v_member.user_id = v_approver_user_id then
      v_approver_org := v_member;
    end if;
  end loop;

  if v_executor_org.user_id is null
     or v_executor_org.status <> 'ACTIVE'
     or v_approver_org.user_id is null
     or v_approver_org.status <> 'ACTIVE' then
    return false;
  end if;

  -- Explicit role policy: FOUNDER is required for FOUNDER grants; ADMIN grants
  -- accept only the explicit FOUNDER/ADMIN allowlist. No lexical hierarchy.
  select wm.* into v_executor_workspace
    from private.workspace_memberships wm
   where wm.organization_id = p_organization_id
     and wm.workspace_id = p_workspace_id
     and wm.user_id = v_executor_user_id
   for update;
  if not found or v_executor_workspace.status <> 'ACTIVE' then return false; end if;

  select g.* into v_grant
    from private.file_mutation_approval_grants g
   where g.grant_id = p_grant_id
   for update;
  if not found
     or v_grant.status <> 'APPROVED'
     or v_grant.consumed_at is not null
     or v_grant.decided_at is null
     or v_grant.expires_at <= clock_timestamp()
     or v_grant.organization_id <> p_organization_id
     or v_grant.workspace_id <> p_workspace_id
     or v_grant.request_id <> p_request_id
     or v_grant.task_id <> p_task_id
     or v_grant.mission_id <> p_mission_id
     or v_grant.requester_user_id <> v_request.requester_user_id
     or v_grant.executor_user_id <> v_executor_user_id
     or v_grant.approver_user_id <> v_approver_user_id
     or v_grant.target_entity_type <> 'FILE'
     or v_grant.target_entity_id <> p_target_entity_id
     or v_grant.operation <> p_operation
     or v_grant.source_path <> p_source_path
     or v_grant.destination_path is distinct from p_destination_path
     or v_grant.input_digest <> p_input_digest
     or (v_grant.required_role = 'FOUNDER' and v_approver_org.role <> 'FOUNDER')
     or (v_grant.required_role = 'ADMIN' and v_approver_org.role not in ('FOUNDER','ADMIN')) then
    return false;
  end if;

  v_now := clock_timestamp();
  update private.file_mutation_approval_grants
     set status = 'CONSUMED',
         consumed_at = v_now
   where grant_id = p_grant_id
     and status = 'APPROVED'
     and consumed_at is null;
  if not found then return false; end if;

  insert into private.file_mutation_approval_events
    (grant_id, actor_user_id, event_type, occurred_at)
  values
    (p_grant_id, v_executor_user_id, 'CONSUMED', v_now);

  return true;
end;
$function$;

revoke all on function public.consume_file_mutation_approval_grant(
  uuid,uuid,uuid,text,text,text,text,text,text,text,text
) from public, anon, service_role;
grant execute on function public.consume_file_mutation_approval_grant(
  uuid,uuid,uuid,text,text,text,text,text,text,text,text
) to authenticated;
