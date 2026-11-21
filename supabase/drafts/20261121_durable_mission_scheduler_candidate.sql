-- DESIGN-ONLY durable mission scheduler candidate.
-- DO NOT APPLY to a connected/shared/production Supabase project.
-- Requires 20261119_async_tenant_persistence_schema_candidate.sql and its
-- private tenant identity tables/functions to be reviewed first.
--
-- This candidate implements an atomic READY-task claim + fenced lease and a
-- transactional, immutable dispatch outbox. It does not start workers or call
-- external providers. All operations derive the principal from auth.uid().
-- Function/table ownership, private-schema privileges, real Supabase JWTs,
-- payload encryption/redaction, retention, and hosted concurrency remain gates.

create table public.happy_mission_task_leases (
  organization_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null references auth.users(id) on delete restrict,
  mission_id text not null,
  task_id text not null,
  lease_id uuid not null,
  owner_id text not null check (length(btrim(owner_id)) > 0),
  attempt integer not null check (attempt >= 1),
  fencing_token bigint not null check (fencing_token >= 1),
  expires_at timestamptz not null,
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint happy_mission_task_leases_pk
    primary key (organization_id, workspace_id, user_id, mission_id, task_id),
  constraint happy_mission_task_leases_lease_id_unique unique (lease_id),
  constraint happy_mission_task_leases_workspace_fk
    foreign key (organization_id, workspace_id)
    references private.workspaces(organization_id, workspace_id)
    on delete restrict
);

create index happy_mission_task_leases_expiry_idx
  on public.happy_mission_task_leases (expires_at);

create table public.happy_execution_dispatch_outbox (
  outbox_id uuid primary key,
  organization_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null references auth.users(id) on delete restrict,
  mission_id text not null,
  task_id text not null,
  lease_id uuid not null,
  fencing_token bigint not null check (fencing_token >= 1),
  attempt integer not null check (attempt >= 1),
  execution_request_id text not null,
  idempotency_key text not null check (length(btrim(idempotency_key)) > 0),
  capability text not null check (length(btrim(capability)) > 0),
  action text not null check (length(btrim(action)) > 0),
  payload_digest text not null check (payload_digest ~ '^sha256:[a-f0-9]{64}$'),
  payload jsonb not null check (jsonb_typeof(payload) = 'object'),
  outcome jsonb not null default '{}'::jsonb check (jsonb_typeof(outcome) = 'object'),
  status text not null default 'PENDING'
    check (status in ('PENDING','DISPATCHED','ACKNOWLEDGED','AMBIGUOUS','FAILED','RECONCILIATION_REQUIRED')),
  created_at timestamptz not null default clock_timestamp(),
  updated_at timestamptz not null default clock_timestamp(),
  constraint happy_execution_dispatch_outbox_idempotency_unique
    unique (organization_id, workspace_id, user_id, idempotency_key),
  constraint happy_execution_dispatch_outbox_request_unique
    unique (organization_id, workspace_id, user_id, execution_request_id),
  constraint happy_execution_dispatch_outbox_workspace_fk
    foreign key (organization_id, workspace_id)
    references private.workspaces(organization_id, workspace_id)
    on delete restrict
);

create index happy_execution_dispatch_outbox_pending_idx
  on public.happy_execution_dispatch_outbox (created_at, outbox_id)
  where status = 'PENDING';

alter table public.happy_mission_task_leases enable row level security;
alter table public.happy_execution_dispatch_outbox enable row level security;
revoke all on public.happy_mission_task_leases from public, anon, authenticated, service_role;
revoke all on public.happy_execution_dispatch_outbox from public, anon, authenticated, service_role;

comment on table public.happy_mission_task_leases is
  'Private durable task lease state. Fencing token increases on every successful reclaim.';
comment on table public.happy_execution_dispatch_outbox is
  'Private transactional outbox. Unique tenant-scoped idempotency key and immutable request binding prevent duplicate intent insertion.';

create or replace function public.happy_claim_mission_task(
  p_organization_id uuid,
  p_workspace_id uuid,
  p_mission_id text,
  p_task_id text,
  p_owner_id text,
  p_lease_milliseconds integer
)
returns table (
  lease_id uuid,
  attempt integer,
  fencing_token bigint,
  expires_at timestamptz,
  task_version bigint
)
language plpgsql
security definer
set search_path = pg_catalog
as $claim$
declare
  v_actor uuid;
  v_mission jsonb;
  v_task jsonb;
  v_task_version bigint;
  v_lease_id uuid := gen_random_uuid();
  v_attempt integer;
  v_fencing_token bigint;
  v_expires_at timestamptz;
  v_dependency text;
begin
  v_actor := auth.uid();
  if v_actor is null
     or p_mission_id is null or length(btrim(p_mission_id)) = 0
     or p_task_id is null or length(btrim(p_task_id)) = 0
     or p_owner_id is null or length(btrim(p_owner_id)) = 0
     or p_lease_milliseconds is null
     or p_lease_milliseconds < 5000 or p_lease_milliseconds > 300000 then
    raise exception 'INVALID_LEASE_INPUT' using errcode = '22023';
  end if;

  if not public.happy_lock_active_tenant_scope(p_organization_id, p_workspace_id) then
    raise exception 'TENANT_SCOPE_DENIED' using errcode = '42501';
  end if;

  -- Stable lock order: mission record, then task record, then lease row.
  select r.data into v_mission
    from public.happy_tenant_records r
   where r.organization_id = p_organization_id
     and r.workspace_id = p_workspace_id
     and r.user_id = v_actor
     and r.entity_type = 'MISSION'
     and r.record_id = p_mission_id
   for update;
  if not found then raise exception 'MISSION_NOT_FOUND' using errcode = 'P0002'; end if;

  select r.data, r.version into v_task, v_task_version
    from public.happy_tenant_records r
   where r.organization_id = p_organization_id
     and r.workspace_id = p_workspace_id
     and r.user_id = v_actor
     and r.entity_type = 'TASK'
     and r.record_id = p_task_id
   for update;
  if not found then raise exception 'TASK_NOT_FOUND' using errcode = 'P0002'; end if;

  if coalesce(v_mission->>'status','') not in ('READY','RUNNING','VERIFYING')
     or v_task->>'missionId' is distinct from p_mission_id
     or coalesce(v_task->>'status','') not in ('READY','RUNNING')
     or jsonb_typeof(v_mission->'taskIds') <> 'array'
     or not ((v_mission->'taskIds') ? p_task_id) then
    raise exception 'TASK_NOT_ELIGIBLE' using errcode = '55000';
  end if;

  -- RUNNING tasks are reclaimable only when their previous persisted lease
  -- exists and has expired. A missing lease is an ambiguous crash window and
  -- must be reconciled, not treated as proof that dispatch never happened.
  if v_task->>'status' = 'RUNNING' and (
    not exists (
      select 1
        from public.happy_mission_task_leases prior
       where prior.organization_id = p_organization_id
         and prior.workspace_id = p_workspace_id
         and prior.user_id = v_actor
         and prior.mission_id = p_mission_id
         and prior.task_id = p_task_id
         and prior.expires_at <= clock_timestamp()
    )
    or exists (
      select 1
        from public.happy_mission_task_leases prior
        join public.happy_execution_dispatch_outbox dispatched
          on dispatched.organization_id = prior.organization_id
         and dispatched.workspace_id = prior.workspace_id
         and dispatched.user_id = prior.user_id
         and dispatched.lease_id = prior.lease_id
       where prior.organization_id = p_organization_id
         and prior.workspace_id = p_workspace_id
         and prior.user_id = v_actor
         and prior.mission_id = p_mission_id
         and prior.task_id = p_task_id
    )
  ) then
    -- Once an outbox row exists, the external side effect may be in flight or
    -- may already have happened. Lease expiry alone is not replay authority.
    raise exception 'RUNNING_TASK_REQUIRES_RECONCILIATION' using errcode = '55000';
  end if;

  if jsonb_typeof(v_task->'dependencyIds') is distinct from 'array' then
    raise exception 'INVALID_TASK_DEPENDENCIES' using errcode = '22023';
  end if;
  for v_dependency in
    select jsonb_array_elements_text(v_task->'dependencyIds')
  loop
    if not exists (
        select 1
          from public.happy_tenant_records dependency
         where dependency.organization_id = p_organization_id
           and dependency.workspace_id = p_workspace_id
           and dependency.user_id = v_actor
           and dependency.entity_type = 'TASK'
           and dependency.record_id = v_dependency
           and dependency.data->>'missionId' = p_mission_id
           and dependency.data->>'status' = 'COMPLETED'
    ) then
      raise exception 'TASK_DEPENDENCY_NOT_COMPLETED' using errcode = '55000';
    end if;
  end loop;

  update public.happy_tenant_records
     set data = jsonb_set(data, '{status}', '"RUNNING"'::jsonb, false),
         version = version + 1,
         updated_at = clock_timestamp()
   where organization_id = p_organization_id
     and workspace_id = p_workspace_id
     and user_id = v_actor
     and entity_type = 'TASK'
     and record_id = p_task_id
     and version = v_task_version;

  if not found then raise exception 'TASK_VERSION_CONFLICT' using errcode = '40001'; end if;

  insert into public.happy_mission_task_leases (
    organization_id, workspace_id, user_id, mission_id, task_id,
    lease_id, owner_id, attempt, fencing_token, expires_at
  ) values (
    p_organization_id, p_workspace_id, v_actor, p_mission_id, p_task_id,
    v_lease_id, p_owner_id, 1, 1,
    clock_timestamp() + make_interval(secs => p_lease_milliseconds::double precision / 1000)
  )
  on conflict (organization_id, workspace_id, user_id, mission_id, task_id)
  do update set
    lease_id = excluded.lease_id,
    owner_id = excluded.owner_id,
    attempt = happy_mission_task_leases.attempt + 1,
    fencing_token = happy_mission_task_leases.fencing_token + 1,
    expires_at = excluded.expires_at,
    updated_at = clock_timestamp()
  where happy_mission_task_leases.expires_at <= clock_timestamp()
  returning happy_mission_task_leases.attempt,
            happy_mission_task_leases.fencing_token,
            happy_mission_task_leases.expires_at
       into v_attempt, v_fencing_token, v_expires_at;

  if not found then raise exception 'LEASE_HELD' using errcode = '55P03'; end if;

  return query select v_lease_id, v_attempt, v_fencing_token, v_expires_at, v_task_version + 1;
end;
$claim$;

create or replace function public.happy_enqueue_mission_dispatch(
  p_organization_id uuid,
  p_workspace_id uuid,
  p_mission_id text,
  p_task_id text,
  p_lease_id uuid,
  p_owner_id text,
  p_fencing_token bigint,
  p_execution_request_id text,
  p_idempotency_key text,
  p_capability text,
  p_action text,
  p_payload_digest text,
  p_payload jsonb
)
returns public.happy_execution_dispatch_outbox
language plpgsql
security definer
set search_path = pg_catalog
as $enqueue$
declare
  v_actor uuid;
  v_lease public.happy_mission_task_leases%rowtype;
  v_outbox public.happy_execution_dispatch_outbox%rowtype;
begin
  v_actor := auth.uid();
  if v_actor is null
     or p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0
     or p_execution_request_id is null or length(btrim(p_execution_request_id)) = 0
     or p_capability is null or length(btrim(p_capability)) = 0
     or p_action is null or length(btrim(p_action)) = 0
     or p_payload_digest is null or p_payload_digest !~ '^sha256:[a-f0-9]{64}$'
     or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'INVALID_DISPATCH_INPUT' using errcode = '22023';
  end if;

  if not public.happy_lock_active_tenant_scope(p_organization_id, p_workspace_id) then
    raise exception 'TENANT_SCOPE_DENIED' using errcode = '42501';
  end if;

  select * into v_lease
    from public.happy_mission_task_leases l
   where l.organization_id = p_organization_id
     and l.workspace_id = p_workspace_id
     and l.user_id = v_actor
     and l.mission_id = p_mission_id
     and l.task_id = p_task_id
   for update;

  if not found
     or v_lease.lease_id <> p_lease_id
     or v_lease.owner_id <> p_owner_id
     or v_lease.fencing_token <> p_fencing_token
     or v_lease.expires_at <= clock_timestamp() then
    raise exception 'STALE_OR_EXPIRED_LEASE' using errcode = '55000';
  end if;

  if p_payload->>'id' is distinct from p_execution_request_id
     or p_payload->>'missionId' is distinct from p_mission_id
     or p_payload->>'taskId' is distinct from p_task_id
     or p_payload->>'capability' is distinct from p_capability
     or p_payload->>'action' is distinct from p_action then
    raise exception 'DISPATCH_PAYLOAD_BINDING_MISMATCH' using errcode = '22023';
  end if;

  insert into public.happy_execution_dispatch_outbox (
    outbox_id, organization_id, workspace_id, user_id,
    mission_id, task_id, lease_id, fencing_token, attempt,
    execution_request_id, idempotency_key, capability, action,
    payload_digest, payload
  ) values (
    gen_random_uuid(), p_organization_id, p_workspace_id, v_actor,
    p_mission_id, p_task_id, v_lease.lease_id, v_lease.fencing_token, v_lease.attempt,
    p_execution_request_id, p_idempotency_key, p_capability, p_action,
    p_payload_digest, p_payload
  )
  on conflict (organization_id, workspace_id, user_id, idempotency_key)
  do nothing
  returning * into v_outbox;

  if found then return v_outbox; end if;

  select * into v_outbox
    from public.happy_execution_dispatch_outbox o
   where o.organization_id = p_organization_id
     and o.workspace_id = p_workspace_id
     and o.user_id = v_actor
     and o.idempotency_key = p_idempotency_key
   for update;

  if not found
     or v_outbox.execution_request_id <> p_execution_request_id
     or v_outbox.mission_id <> p_mission_id
     or v_outbox.task_id <> p_task_id
     or v_outbox.lease_id <> v_lease.lease_id
     or v_outbox.fencing_token <> v_lease.fencing_token
     or v_outbox.attempt <> v_lease.attempt
     or v_outbox.capability <> p_capability
     or v_outbox.action <> p_action
     or v_outbox.payload_digest <> p_payload_digest
     or v_outbox.payload <> p_payload then
    raise exception 'IDEMPOTENCY_KEY_REUSE_MISMATCH' using errcode = '23505';
  end if;

  return v_outbox;
end;
$enqueue$;


create or replace function public.happy_heartbeat_mission_task_lease(
  p_organization_id uuid,
  p_workspace_id uuid,
  p_mission_id text,
  p_task_id text,
  p_lease_id uuid,
  p_owner_id text,
  p_fencing_token bigint,
  p_lease_milliseconds integer
)
returns timestamptz
language plpgsql
security definer
set search_path = pg_catalog
as $heartbeat$
declare
  v_actor uuid;
  v_expires_at timestamptz;
begin
  v_actor := auth.uid();
  if v_actor is null or p_lease_milliseconds is null
     or p_lease_milliseconds < 5000 or p_lease_milliseconds > 300000 then
    raise exception 'INVALID_HEARTBEAT_INPUT' using errcode = '22023';
  end if;
  if not public.happy_lock_active_tenant_scope(p_organization_id, p_workspace_id) then
    raise exception 'TENANT_SCOPE_DENIED' using errcode = '42501';
  end if;

  update public.happy_mission_task_leases l
     set expires_at = clock_timestamp() + make_interval(secs => p_lease_milliseconds::double precision / 1000),
         updated_at = clock_timestamp()
   where l.organization_id = p_organization_id
     and l.workspace_id = p_workspace_id
     and l.user_id = v_actor
     and l.mission_id = p_mission_id
     and l.task_id = p_task_id
     and l.lease_id = p_lease_id
     and l.owner_id = p_owner_id
     and l.fencing_token = p_fencing_token
     and l.expires_at > clock_timestamp()
  returning l.expires_at into v_expires_at;

  if not found then raise exception 'STALE_OR_EXPIRED_LEASE' using errcode = '55000'; end if;
  return v_expires_at;
end;
$heartbeat$;

create or replace function public.happy_claim_dispatch_outbox(
  p_organization_id uuid,
  p_workspace_id uuid,
  p_outbox_id uuid,
  p_lease_id uuid,
  p_owner_id text,
  p_fencing_token bigint
)
returns public.happy_execution_dispatch_outbox
language plpgsql
security definer
set search_path = pg_catalog
as $dispatch$
declare
  v_actor uuid;
  v_lease public.happy_mission_task_leases%rowtype;
  v_outbox public.happy_execution_dispatch_outbox%rowtype;
begin
  v_actor := auth.uid();
  if v_actor is null or p_outbox_id is null then
    raise exception 'INVALID_OUTBOX_CLAIM_INPUT' using errcode = '22023';
  end if;
  if not public.happy_lock_active_tenant_scope(p_organization_id, p_workspace_id) then
    raise exception 'TENANT_SCOPE_DENIED' using errcode = '42501';
  end if;

  -- Read the immutable task binding first without a row lock, then lock in
  -- the shared lease -> outbox order used by enqueue to avoid lock inversion.
  select * into v_outbox
    from public.happy_execution_dispatch_outbox o
   where o.organization_id = p_organization_id
     and o.workspace_id = p_workspace_id
     and o.user_id = v_actor
     and o.outbox_id = p_outbox_id;
  if not found then raise exception 'OUTBOX_NOT_FOUND' using errcode = 'P0002'; end if;

  select * into v_lease
    from public.happy_mission_task_leases l
   where l.organization_id = p_organization_id
     and l.workspace_id = p_workspace_id
     and l.user_id = v_actor
     and l.mission_id = v_outbox.mission_id
     and l.task_id = v_outbox.task_id
   for update;

  if not found
     or v_lease.lease_id <> p_lease_id
     or v_lease.lease_id <> v_outbox.lease_id
     or v_lease.owner_id <> p_owner_id
     or v_lease.fencing_token <> p_fencing_token
     or v_lease.fencing_token <> v_outbox.fencing_token
     or v_lease.expires_at <= clock_timestamp() then
    raise exception 'STALE_OR_EXPIRED_LEASE' using errcode = '55000';
  end if;

  -- Re-read and lock the outbox only after the lease lock. The row may
  -- have changed since the initial non-locking lookup.
  select * into v_outbox
    from public.happy_execution_dispatch_outbox o
   where o.organization_id = p_organization_id
     and o.workspace_id = p_workspace_id
     and o.user_id = v_actor
     and o.outbox_id = p_outbox_id
   for update;
  if not found
     or v_outbox.lease_id <> v_lease.lease_id
     or v_outbox.fencing_token <> v_lease.fencing_token then
    raise exception 'STALE_OR_EXPIRED_LEASE' using errcode = '55000';
  end if;

  if v_outbox.status <> 'PENDING' then
    raise exception 'OUTBOX_ALREADY_CLAIMED_OR_REQUIRES_RECONCILIATION' using errcode = '55000';
  end if;

  update public.happy_execution_dispatch_outbox
     set status = 'DISPATCHED', updated_at = clock_timestamp()
   where outbox_id = v_outbox.outbox_id
     and status = 'PENDING'
  returning * into v_outbox;

  if not found then raise exception 'OUTBOX_ALREADY_CLAIMED_OR_REQUIRES_RECONCILIATION' using errcode = '55000'; end if;
  return v_outbox;
end;
$dispatch$;


create or replace function public.happy_record_dispatch_outcome(
  p_organization_id uuid,
  p_workspace_id uuid,
  p_outbox_id uuid,
  p_lease_id uuid,
  p_owner_id text,
  p_fencing_token bigint,
  p_status text,
  p_outcome jsonb
)
returns public.happy_execution_dispatch_outbox
language plpgsql
security definer
set search_path = pg_catalog
as $outcome$
declare
  v_actor uuid;
  v_outbox public.happy_execution_dispatch_outbox%rowtype;
  v_lease public.happy_mission_task_leases%rowtype;
begin
  v_actor := auth.uid();
  if v_actor is null
     or p_outbox_id is null
     or p_status is null
     or p_status not in ('ACKNOWLEDGED','AMBIGUOUS','FAILED','RECONCILIATION_REQUIRED')
     or p_outcome is null
     or jsonb_typeof(p_outcome) is distinct from 'object' then
    raise exception 'INVALID_DISPATCH_OUTCOME' using errcode = '22023';
  end if;
  if not public.happy_lock_active_tenant_scope(p_organization_id, p_workspace_id) then
    raise exception 'TENANT_SCOPE_DENIED' using errcode = '42501';
  end if;

  -- Lock order matches enqueue and outbox claim: lease before outbox.
  select * into v_outbox
    from public.happy_execution_dispatch_outbox o
   where o.organization_id = p_organization_id
     and o.workspace_id = p_workspace_id
     and o.user_id = v_actor
     and o.outbox_id = p_outbox_id;
  if not found then raise exception 'OUTBOX_NOT_FOUND' using errcode = 'P0002'; end if;

  select * into v_lease
    from public.happy_mission_task_leases l
   where l.organization_id = p_organization_id
     and l.workspace_id = p_workspace_id
     and l.user_id = v_actor
     and l.mission_id = v_outbox.mission_id
     and l.task_id = v_outbox.task_id
   for update;
  if not found
     or v_lease.lease_id <> p_lease_id
     or v_lease.lease_id <> v_outbox.lease_id
     or v_lease.owner_id <> p_owner_id
     or v_lease.fencing_token <> p_fencing_token
     or v_lease.fencing_token <> v_outbox.fencing_token then
    raise exception 'STALE_LEASE_OUTCOME' using errcode = '55000';
  end if;

  select * into v_outbox
    from public.happy_execution_dispatch_outbox o
   where o.organization_id = p_organization_id
     and o.workspace_id = p_workspace_id
     and o.user_id = v_actor
     and o.outbox_id = p_outbox_id
   for update;
  if not found or v_outbox.status <> 'DISPATCHED' then
    raise exception 'OUTBOX_OUTCOME_ALREADY_RECORDED_OR_NOT_DISPATCHED' using errcode = '55000';
  end if;

  update public.happy_execution_dispatch_outbox
     set status = p_status,
         outcome = p_outcome,
         updated_at = clock_timestamp()
   where outbox_id = p_outbox_id
     and status = 'DISPATCHED'
  returning * into v_outbox;
  if not found then
    raise exception 'OUTBOX_OUTCOME_ALREADY_RECORDED_OR_NOT_DISPATCHED' using errcode = '55000';
  end if;
  return v_outbox;
end;
$outcome$;

revoke all on function public.happy_claim_mission_task(uuid,uuid,text,text,text,integer)
  from public, anon, service_role;
revoke all on function public.happy_heartbeat_mission_task_lease(uuid,uuid,text,text,uuid,text,bigint,integer)
  from public, anon, service_role;
revoke all on function public.happy_claim_dispatch_outbox(uuid,uuid,uuid,uuid,text,bigint)
  from public, anon, service_role;
revoke all on function public.happy_record_dispatch_outcome(uuid,uuid,uuid,uuid,text,bigint,text,jsonb)
  from public, anon, service_role;
revoke all on function public.happy_enqueue_mission_dispatch(uuid,uuid,text,text,uuid,text,bigint,text,text,text,text,text,jsonb)
  from public, anon, service_role;
grant execute on function public.happy_claim_mission_task(uuid,uuid,text,text,text,integer)
  to authenticated;
grant execute on function public.happy_heartbeat_mission_task_lease(uuid,uuid,text,text,uuid,text,bigint,integer)
  to authenticated;
grant execute on function public.happy_claim_dispatch_outbox(uuid,uuid,uuid,uuid,text,bigint)
  to authenticated;
grant execute on function public.happy_record_dispatch_outcome(uuid,uuid,uuid,uuid,text,bigint,text,jsonb)
  to authenticated;
grant execute on function public.happy_enqueue_mission_dispatch(uuid,uuid,text,text,uuid,text,bigint,text,text,text,text,text,jsonb)
  to authenticated;

-- LIMITATIONS / REQUIRED FOLLOW-UP:
-- 1. Claim currently accepts only READY tasks. Retry must be an explicit,
--    separately authorized transition back to READY after policy/approval review.
-- 2. This RPC atomically checks dependency status but a production graph must
--    also enforce immutable mission membership and complete dependency graph
--    integrity at task creation/update boundaries.
-- 3. Outbox payload is JSONB. Production must define secret redaction/encryption,
--    payload size limits, retention, and provider-specific serialization.
-- 4. No worker polling/dispatch/acknowledgement or external side-effect
--    idempotency is implemented. Ambiguous outcomes must reconcile, never
--    blindly replay.
-- 5. Function ownership and the private tenant lock helper's owner privileges
--    are unresolved. Verify real Supabase JWT/RLS/role behavior before migration.
-- 6. This is a draft only; no connected database was changed.
