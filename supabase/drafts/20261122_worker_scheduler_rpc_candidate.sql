-- HAPPY worker-specific durable scheduler RPCs (DESIGN DRAFT ONLY)
-- Date: 2026-11-22
-- Depends on the durable scheduler and worker principal registry candidate SQL.
-- Never apply to hosted Supabase until dedicated LOGIN role, session_user
-- preservation, function ownership, RLS and grants have been reviewed.
--
-- Each RPC takes a worker ID and user ID only as selectors. The worker is
-- independently derived from PostgreSQL session_user and matched to the
-- supplied worker ID. The user is checked against the operator-managed tenant
-- grant and active canonical organization/workspace memberships in the same
-- transaction. These worker RPCs never use auth.uid() or JWT claim GUCs.
--
-- All EXECUTE grants are intentionally withheld.

begin;

-- Worker-only twin of happy_claim_mission_task; uses DB-derived identity and a
-- transactionally locked worker-to-user tenant scope.
create or replace function private.happy_worker_claim_mission_task(
  p_worker_principal_id uuid,
  p_organization_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
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
  v_actor := private.happy_require_worker_tenant_scope(
    p_worker_principal_id, p_organization_id, p_workspace_id, p_user_id,
    'CONTROL'
  );
  if v_actor is null
     or p_mission_id is null or length(btrim(p_mission_id)) = 0
     or p_task_id is null or length(btrim(p_task_id)) = 0
     or p_owner_id is null or length(btrim(p_owner_id)) = 0
     or p_lease_milliseconds is null
     or p_lease_milliseconds < 5000 or p_lease_milliseconds > 300000 then
    raise exception 'INVALID_LEASE_INPUT' using errcode = '22023';
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
     or coalesce(v_task->>'status','') not in ('PENDING','READY','RUNNING')
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

-- Worker-only twin of happy_enqueue_mission_dispatch; uses DB-derived identity and a
-- transactionally locked worker-to-user tenant scope.
create or replace function private.happy_worker_enqueue_mission_dispatch(
  p_worker_principal_id uuid,
  p_organization_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
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
  v_request private.execution_requests%rowtype;
  v_request_envelope jsonb;
  v_input_digest text;
  v_envelope_digest text;
  v_expected_payload jsonb;
  v_computed_payload_digest text;
  v_expected_idempotency_key text;
  v_created_at_iso text;
  v_outbox public.happy_execution_dispatch_outbox%rowtype;
begin
  v_actor := private.happy_require_worker_tenant_scope(
    p_worker_principal_id, p_organization_id, p_workspace_id, p_user_id,
    'CONTROL'
  );
  if v_actor is null
     or p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0
     or p_execution_request_id is null or length(btrim(p_execution_request_id)) = 0
     or p_capability is null or length(btrim(p_capability)) = 0
     or p_action is null or length(btrim(p_action)) = 0
     or p_payload_digest is null or p_payload_digest !~ '^sha256:[a-f0-9]{64}$'
     or p_payload is null or jsonb_typeof(p_payload) <> 'object' then
    raise exception 'INVALID_DISPATCH_INPUT' using errcode = '22023';
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

  -- The execution request is the canonical authority. Lock the exact
  -- tenant/request/task/mission row and require a persisted founder decision.
  -- Caller-supplied IDs, payload and digest are comparison inputs only.
  select r.* into v_request
    from private.execution_requests r
   where r.request_id = p_execution_request_id
     and r.organization_id = p_organization_id
     and r.workspace_id = p_workspace_id
     and r.requester_user_id = v_actor
     and r.executor_user_id = v_actor
     and r.mission_id = p_mission_id
     and r.task_id = p_task_id
   for update;

  if not found
     or v_request.status <> 'READY'
     or v_request.approval_status <> 'APPROVED'
     or v_request.requires_approval is distinct from true
     or v_request.required_approval_role <> 'FOUNDER'
     or v_request.decided_by is null
     or v_request.decided_by in (v_request.requester_user_id,v_request.executor_user_id)
     or v_request.decided_at is null
     or v_request.capability is null
     or v_request.action is null
     or v_request.input is null
     or v_request.input_digest is null
     or v_request.envelope_digest is null
     or v_request.risk <> 'HIGH'
     or v_request.idempotency_key is null
     or v_request.created_at is null then
    raise exception 'PERSISTED_APPROVED_EXECUTION_REQUEST_REQUIRED' using errcode = '42501';
  end if;

  -- Recompute both persisted digests from the immutable columns. The
  -- envelope digest intentionally records PENDING approval as immutable intent;
  -- approval itself is separately evidenced by decided_by/decided_at/status.
  v_input_digest := encode(
    extensions.digest(convert_to(v_request.input::text,'UTF8'),'sha256'),
    'hex'
  );
  v_request_envelope := jsonb_build_object(
    'requestId',v_request.request_id,
    'taskId',v_request.task_id,
    'missionId',v_request.mission_id,
    'requesterUserId',v_request.requester_user_id,
    'executorUserId',v_request.executor_user_id,
    'organizationId',v_request.organization_id,
    'workspaceId',v_request.workspace_id,
    'capability',v_request.capability,
    'action',v_request.action,
    'input',v_request.input,
    'targetReference',v_request.target_reference,
    'requiresApproval',v_request.requires_approval,
    'risk',v_request.risk,
    'approvalStatus','PENDING',
    'requiredApprovalRole',v_request.required_approval_role,
    'idempotencyKey',v_request.idempotency_key
  );
  v_envelope_digest := encode(
    extensions.digest(convert_to(v_request_envelope::text,'UTF8'),'sha256'),
    'hex'
  );

  if v_input_digest <> v_request.input_digest
     or v_envelope_digest <> v_request.envelope_digest then
    raise exception 'PERSISTED_EXECUTION_REQUEST_DIGEST_MISMATCH' using errcode = '22000';
  end if;

  v_created_at_iso := to_char(
    v_request.created_at at time zone 'UTC',
    'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
  );
  v_expected_idempotency_key := 'happy-dispatch:v1:' || encode(
    extensions.digest(
      convert_to(
        p_organization_id::text || chr(31) ||
        p_workspace_id::text || chr(31) ||
        v_actor::text || chr(31) ||
        p_mission_id || chr(31) ||
        p_task_id || chr(31) ||
        v_lease.attempt::text || chr(31) ||
        v_request.request_id || chr(31) ||
        v_request.capability || chr(31) ||
        v_request.action,
        'UTF8'
      ),
      'sha256'
    ),
    'hex'
  );
  v_expected_payload := jsonb_build_object(
    'id',v_request.request_id,
    'taskId',v_request.task_id,
    'missionId',v_request.mission_id,
    'capability',v_request.capability,
    'action',v_request.action,
    'input',v_request.input,
    'targetReference',v_request.target_reference,
    'requiresApproval',true,
    'approved',true,
    'risk',v_request.risk,
    'createdAt',v_created_at_iso
  );

  v_computed_payload_digest := 'sha256:' || encode(
    extensions.digest(
      convert_to(private.happy_canonical_jsonb(v_expected_payload),'UTF8'),
      'sha256'
    ),
    'hex'
  );

  if p_payload is distinct from v_expected_payload
     or p_execution_request_id is distinct from v_request.request_id
     or p_idempotency_key is distinct from v_expected_idempotency_key
     or p_capability is distinct from v_request.capability
     or p_action is distinct from v_request.action
     or p_payload_digest is distinct from v_computed_payload_digest then
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
    v_computed_payload_digest, v_expected_payload
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
     or v_outbox.payload_digest <> v_computed_payload_digest
     or v_outbox.payload <> v_expected_payload then
    raise exception 'IDEMPOTENCY_KEY_REUSE_MISMATCH' using errcode = '23505';
  end if;

  return v_outbox;
end;
$enqueue$;

-- Worker-only twin of happy_heartbeat_mission_task_lease; uses DB-derived identity and a
-- transactionally locked worker-to-user tenant scope.
create or replace function private.happy_worker_heartbeat_mission_task_lease(
  p_worker_principal_id uuid,
  p_organization_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
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
  v_actor := private.happy_require_worker_tenant_scope(
    p_worker_principal_id, p_organization_id, p_workspace_id, p_user_id,
    'CONTROL'
  );
  if v_actor is null or p_lease_milliseconds is null
     or p_lease_milliseconds < 5000 or p_lease_milliseconds > 300000 then
    raise exception 'INVALID_HEARTBEAT_INPUT' using errcode = '22023';
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

-- Worker-only twin of happy_claim_dispatch_outbox; uses DB-derived identity and a
-- transactionally locked worker-to-user tenant scope.
create or replace function private.happy_worker_claim_dispatch_outbox(
  p_worker_principal_id uuid,
  p_organization_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
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
  v_actor := private.happy_require_worker_tenant_scope(
    p_worker_principal_id, p_organization_id, p_workspace_id, p_user_id,
    'CONTROL'
  );
  if v_actor is null or p_outbox_id is null then
    raise exception 'INVALID_OUTBOX_CLAIM_INPUT' using errcode = '22023';
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

-- Atomically claims the next eligible PENDING outbox row for this tenant.
-- Lock order is lease -> outbox, matching the other worker scheduler RPCs.
create or replace function private.happy_worker_claim_next_dispatch_outbox(
  p_worker_principal_id uuid,
  p_organization_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
  p_owner_id text
)
returns setof public.happy_execution_dispatch_outbox
language plpgsql
security definer
set search_path = pg_catalog
as $claim_next$
declare
  v_actor uuid;
  v_lease public.happy_mission_task_leases%rowtype;
  v_outbox public.happy_execution_dispatch_outbox%rowtype;
  v_request private.execution_requests%rowtype;
begin
  v_actor := private.happy_require_worker_tenant_scope(
    p_worker_principal_id, p_organization_id, p_workspace_id, p_user_id,
    'CONTROL'
  );
  if v_actor is null or p_owner_id is null or length(btrim(p_owner_id)) = 0 then
    raise exception 'WORKER_TENANT_SCOPE_REQUIRED' using errcode = '42501';
  end if;

  -- Lock one eligible lease first. SKIP LOCKED lets concurrent workers safely
  -- compete without selecting a lease another worker is currently claiming.
  select l.* into v_lease
    from public.happy_mission_task_leases l
   where l.organization_id = p_organization_id
     and l.workspace_id = p_workspace_id
     and l.user_id = v_actor
     and l.owner_id = p_owner_id
     and l.expires_at > clock_timestamp()
     and l.fencing_token > 0
     and exists (
       select 1
         from public.happy_execution_dispatch_outbox o
        where o.organization_id = l.organization_id
          and o.workspace_id = l.workspace_id
          and o.user_id = l.user_id
          and o.lease_id = l.lease_id
          and o.fencing_token = l.fencing_token
          and o.status = 'PENDING'
     )
   order by l.updated_at, l.lease_id
   limit 1
   for update of l skip locked;

  if not found then
    return;
  end if;

  -- Preserve the common lease -> outbox lock order and re-check all bindings
  -- after acquiring the outbox lock.
  select o.* into v_outbox
    from public.happy_execution_dispatch_outbox o
   where o.organization_id = p_organization_id
     and o.workspace_id = p_workspace_id
     and o.user_id = v_actor
     and o.lease_id = v_lease.lease_id
     and o.fencing_token = v_lease.fencing_token
     and o.status = 'PENDING'
   order by o.created_at, o.outbox_id
   limit 1
   for update;

  if not found then
    return;
  end if;

  if v_lease.expires_at <= clock_timestamp()
     or v_lease.owner_id is null or length(btrim(v_lease.owner_id)) = 0
     or v_outbox.lease_id <> v_lease.lease_id
     or v_outbox.fencing_token <> v_lease.fencing_token then
    raise exception 'STALE_OR_EXPIRED_DISPATCH_LEASE' using errcode = '55000';
  end if;

  -- Approval is revalidated at dispatch time, not only when the outbox was
  -- enqueued. The request row is locked so a concurrent approval revocation
  -- cannot race the transition from PENDING to DISPATCHED.
  select r.* into v_request
    from private.execution_requests r
   where r.request_id = v_outbox.execution_request_id
     and r.organization_id = p_organization_id
     and r.workspace_id = p_workspace_id
     and r.requester_user_id = v_actor
     and r.executor_user_id = v_actor
     and r.mission_id = v_outbox.mission_id
     and r.task_id = v_outbox.task_id
   for share;

  if not found
     or v_request.status <> 'READY'
     or v_request.approval_status <> 'APPROVED'
     or v_request.requires_approval is distinct from true
     or v_request.required_approval_role <> 'FOUNDER'
     or v_request.decided_by is null
     or v_request.decided_by in (v_request.requester_user_id,v_request.executor_user_id)
     or v_request.decided_at is null
     or v_request.risk <> 'HIGH'
     or v_request.idempotency_key <> v_outbox.idempotency_key
     or v_request.capability <> v_outbox.capability
     or v_request.action <> v_outbox.action then
    raise exception 'PERSISTED_APPROVED_EXECUTION_REQUEST_REQUIRED' using errcode = '42501';
  end if;

  update public.happy_execution_dispatch_outbox
     set status = 'DISPATCHED',
         updated_at = clock_timestamp()
   where outbox_id = v_outbox.outbox_id
     and organization_id = p_organization_id
     and workspace_id = p_workspace_id
     and user_id = v_actor
     and status = 'PENDING'
  returning * into v_outbox;

  if not found then
    raise exception 'OUTBOX_ALREADY_CLAIMED' using errcode = '55000';
  end if;

  return next v_outbox;
  return;
end;
$claim_next$;

-- Worker-only twin of happy_record_dispatch_outcome; uses DB-derived identity and a
-- transactionally locked worker-to-user tenant scope.
create or replace function private.happy_worker_record_dispatch_outcome(
  p_worker_principal_id uuid,
  p_organization_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
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
  v_actor := private.happy_require_worker_tenant_scope(
    p_worker_principal_id, p_organization_id, p_workspace_id, p_user_id,
    'CONTROL'
  );
  if v_actor is null
     or p_outbox_id is null
     or p_status is null
     or p_status not in ('ACKNOWLEDGED','AMBIGUOUS','FAILED','RECONCILIATION_REQUIRED')
     or p_outcome is null
     or jsonb_typeof(p_outcome) is distinct from 'object' then
    raise exception 'INVALID_DISPATCH_OUTCOME' using errcode = '22023';
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

-- Worker-only twin of happy_append_dispatch_reconciliation_evidence; uses DB-derived identity and a
-- transactionally locked worker-to-user tenant scope.
create or replace function private.happy_worker_append_dispatch_reconciliation_evidence(
  p_worker_principal_id uuid,
  p_organization_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
  p_outbox_id uuid,
  p_evidence_id uuid,
  p_idempotency_key text,
  p_provider_id text,
  p_observation_status text,
  p_observed_at timestamptz,
  p_observation jsonb
)
returns uuid
language plpgsql
security definer
set search_path = pg_catalog
as $append$
declare
  v_actor uuid;
  v_outbox public.happy_execution_dispatch_outbox%rowtype;
  v_existing public.happy_dispatch_reconciliation_evidence%rowtype;
begin
  v_actor := private.happy_require_worker_tenant_scope(
    p_worker_principal_id, p_organization_id, p_workspace_id, p_user_id,
    'VERIFY'
  );
  if v_actor is null
     or p_outbox_id is null
     or p_evidence_id is null
     or p_idempotency_key is null or length(btrim(p_idempotency_key)) = 0
     or p_provider_id is null or length(btrim(p_provider_id)) = 0
     or p_observation_status is null
     or p_observation_status not in ('SUCCEEDED','FAILED','PROCESSING','NOT_FOUND','UNKNOWN')
     or p_observed_at is null
     or p_observation is null
     or jsonb_typeof(p_observation) is distinct from 'object'
     or p_observation->>'status' is distinct from p_observation_status then
    raise exception 'INVALID_RECONCILIATION_EVIDENCE' using errcode = '22023';
  end if;

  -- The original outcome remains immutable. Only ambiguous dispatches may
  -- receive status observations, and the provider/key must match that record.
  select * into v_outbox
    from public.happy_execution_dispatch_outbox o
   where o.organization_id = p_organization_id
     and o.workspace_id = p_workspace_id
     and o.user_id = v_actor
     and o.outbox_id = p_outbox_id
   for share;

  if not found then raise exception 'OUTBOX_NOT_FOUND' using errcode = 'P0002'; end if;
  if v_outbox.status not in ('AMBIGUOUS','RECONCILIATION_REQUIRED')
     or v_outbox.idempotency_key <> p_idempotency_key
     or v_outbox.outcome->>'provider' is distinct from p_provider_id then
    raise exception 'RECONCILIATION_TARGET_BINDING_MISMATCH' using errcode = '55000';
  end if;

  insert into public.happy_dispatch_reconciliation_evidence (
    evidence_id, organization_id, workspace_id, user_id, outbox_id,
    idempotency_key, provider_id, observation_status, observed_at, observation
  ) values (
    p_evidence_id, p_organization_id, p_workspace_id, v_actor, p_outbox_id,
    p_idempotency_key, p_provider_id, p_observation_status, p_observed_at, p_observation
  )
  on conflict (organization_id, workspace_id, user_id, evidence_id)
  do nothing;

  if found then return p_evidence_id; end if;

  select * into v_existing
    from public.happy_dispatch_reconciliation_evidence e
   where e.organization_id = p_organization_id
     and e.workspace_id = p_workspace_id
     and e.user_id = v_actor
     and e.evidence_id = p_evidence_id;

  if not found
     or v_existing.outbox_id <> p_outbox_id
     or v_existing.idempotency_key <> p_idempotency_key
     or v_existing.provider_id <> p_provider_id
     or v_existing.observation_status <> p_observation_status
     or v_existing.observed_at <> p_observed_at
     or v_existing.observation <> p_observation then
    raise exception 'RECONCILIATION_EVIDENCE_ID_REUSE_MISMATCH' using errcode = '23505';
  end if;

  return p_evidence_id;
end;
$append$;

-- Worker-only twin of happy_list_dispatch_reconciliation_evidence; uses DB-derived identity and a
-- transactionally locked worker-to-user tenant scope.
create or replace function private.happy_worker_list_dispatch_reconciliation_evidence(
  p_worker_principal_id uuid,
  p_organization_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
  p_outbox_id uuid,
  p_mission_id text,
  p_task_id text,
  p_execution_request_id text
)
returns table (
  evidence_id uuid,
  outbox_id uuid,
  idempotency_key text,
  provider_id text,
  observation_status text,
  observed_at timestamptz,
  observation jsonb
)
language plpgsql
security definer
set search_path = pg_catalog
as $read_evidence$
declare
  v_actor uuid;
  v_outbox public.happy_execution_dispatch_outbox%rowtype;
  v_mission jsonb;
  v_task jsonb;
begin
  v_actor := private.happy_require_worker_tenant_scope(
    p_worker_principal_id, p_organization_id, p_workspace_id, p_user_id,
    'VERIFY'
  );
  if v_actor is null or p_outbox_id is null
     or p_mission_id is null or length(btrim(p_mission_id)) = 0
     or p_task_id is null or length(btrim(p_task_id)) = 0
     or p_execution_request_id is null or length(btrim(p_execution_request_id)) = 0 then
    raise exception 'INVALID_RECONCILIATION_READ_BINDING' using errcode = '22023';
  end if;

  -- Re-bind the requested mission/task to the authenticated tenant's current
  -- persisted snapshot; do not trust caller-supplied IDs or outbox metadata alone.
  select r.data into v_mission
    from public.happy_tenant_records r
   where r.organization_id = p_organization_id
     and r.workspace_id = p_workspace_id
     and r.user_id = v_actor
     and r.entity_type = 'MISSION'
     and r.record_id = p_mission_id;
  if not found
     or jsonb_typeof(v_mission->'taskIds') is distinct from 'array'
     or not ((v_mission->'taskIds') ? p_task_id) then
    raise exception 'RECONCILIATION_MISSION_TASK_BINDING_MISMATCH' using errcode = '55000';
  end if;

  select r.data into v_task
    from public.happy_tenant_records r
   where r.organization_id = p_organization_id
     and r.workspace_id = p_workspace_id
     and r.user_id = v_actor
     and r.entity_type = 'TASK'
     and r.record_id = p_task_id;
  if not found or v_task->>'missionId' is distinct from p_mission_id then
    raise exception 'RECONCILIATION_MISSION_TASK_BINDING_MISMATCH' using errcode = '55000';
  end if;

  select * into v_outbox
    from public.happy_execution_dispatch_outbox o
   where o.organization_id = p_organization_id
     and o.workspace_id = p_workspace_id
     and o.user_id = v_actor
     and o.outbox_id = p_outbox_id;
  if not found
     or v_outbox.mission_id <> p_mission_id
     or v_outbox.task_id <> p_task_id
     or v_outbox.execution_request_id <> p_execution_request_id
     or v_outbox.payload->>'id' is distinct from p_execution_request_id
     or v_outbox.payload->>'missionId' is distinct from p_mission_id
     or v_outbox.payload->>'taskId' is distinct from p_task_id
     or v_outbox.status not in ('DISPATCHED','AMBIGUOUS','RECONCILIATION_REQUIRED') then
    raise exception 'RECONCILIATION_READ_TARGET_BINDING_MISMATCH' using errcode = '55000';
  end if;

  return query
    select e.evidence_id, e.outbox_id, e.idempotency_key, e.provider_id,
           e.observation_status, e.observed_at, e.observation
      from public.happy_dispatch_reconciliation_evidence e
     where e.organization_id = p_organization_id
       and e.workspace_id = p_workspace_id
       and e.user_id = v_actor
       and e.outbox_id = p_outbox_id
     order by e.observed_at, e.evidence_id;
end;
$read_evidence$;

revoke all on function private.happy_worker_claim_mission_task(uuid,uuid,uuid,uuid,text,text,text,integer)
  from public, anon, authenticated, service_role;

revoke all on function private.happy_worker_enqueue_mission_dispatch(uuid,uuid,uuid,uuid,text,text,uuid,text,bigint,text,text,text,text,text,jsonb)
  from public, anon, authenticated, service_role;

revoke all on function private.happy_worker_heartbeat_mission_task_lease(uuid,uuid,uuid,uuid,text,text,uuid,text,bigint,integer)
  from public, anon, authenticated, service_role;

revoke all on function private.happy_worker_claim_dispatch_outbox(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint)
  from public, anon, authenticated, service_role;

revoke all on function private.happy_worker_claim_next_dispatch_outbox(uuid,uuid,uuid,uuid,text)
  from public, anon, authenticated, service_role;

revoke all on function private.happy_worker_record_dispatch_outcome(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint,text,jsonb)
  from public, anon, authenticated, service_role;

revoke all on function private.happy_worker_append_dispatch_reconciliation_evidence(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,timestamptz,jsonb)
  from public, anon, authenticated, service_role;

revoke all on function private.happy_worker_list_dispatch_reconciliation_evidence(uuid,uuid,uuid,uuid,uuid,text,text,text)
  from public, anon, authenticated, service_role;

commit;
