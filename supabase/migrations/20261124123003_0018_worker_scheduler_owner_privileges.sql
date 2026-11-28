-- DESIGN-ONLY worker scheduler owner grants, RLS policies and function ownership.
-- Requires canonical tenant identity, worker registry, tenant persistence,
-- durable scheduler tables, execution request envelope, and both worker owner roles.
-- DO NOT APPLY until exact hosted table/function signatures are reviewed.
BEGIN;

GRANT USAGE ON SCHEMA private,public,extensions TO happy_worker_scheduler_rpc_owner;
GRANT EXECUTE ON FUNCTION private.happy_require_worker_tenant_scope(uuid,uuid,uuid,uuid,text)
  TO happy_worker_scheduler_rpc_owner;
GRANT EXECUTE ON FUNCTION private.happy_worker_tenant_scope_policy(uuid,uuid,uuid,text)
  TO happy_worker_scheduler_rpc_owner;
GRANT EXECUTE ON FUNCTION private.happy_canonical_jsonb(jsonb)
  TO happy_worker_scheduler_rpc_owner;
GRANT EXECUTE ON FUNCTION extensions.digest(bytea,text)
  TO happy_worker_scheduler_rpc_owner;

-- Tenant mission/task snapshots: CONTROL workers can read and CAS-update only
-- mission/task payload columns; VERIFY workers can read them for evidence binding.
DROP POLICY IF EXISTS happy_worker_scheduler_control_select ON public.happy_tenant_records;
CREATE POLICY happy_worker_scheduler_control_select ON public.happy_tenant_records
  FOR SELECT TO happy_worker_scheduler_rpc_owner
  USING (
    entity_type IN ('MISSION','TASK')
    AND private.happy_worker_tenant_scope_policy(organization_id,workspace_id,user_id,'CONTROL')
  );
DROP POLICY IF EXISTS happy_worker_scheduler_verify_select ON public.happy_tenant_records;
CREATE POLICY happy_worker_scheduler_verify_select ON public.happy_tenant_records
  FOR SELECT TO happy_worker_scheduler_rpc_owner
  USING (
    entity_type IN ('MISSION','TASK')
    AND private.happy_worker_tenant_scope_policy(organization_id,workspace_id,user_id,'VERIFY')
  );
DROP POLICY IF EXISTS happy_worker_scheduler_control_update ON public.happy_tenant_records;
CREATE POLICY happy_worker_scheduler_control_update ON public.happy_tenant_records
  FOR UPDATE TO happy_worker_scheduler_rpc_owner
  USING (
    entity_type IN ('MISSION','TASK')
    AND private.happy_worker_tenant_scope_policy(organization_id,workspace_id,user_id,'CONTROL')
  )
  WITH CHECK (
    entity_type IN ('MISSION','TASK')
    AND private.happy_worker_tenant_scope_policy(organization_id,workspace_id,user_id,'CONTROL')
  );
GRANT SELECT ON public.happy_tenant_records TO happy_worker_scheduler_rpc_owner;
GRANT UPDATE (data,version,updated_at)
  ON public.happy_tenant_records TO happy_worker_scheduler_rpc_owner;

-- Fenced leases: mutable columns are explicit; tenant key columns are immutable.
DROP POLICY IF EXISTS happy_worker_scheduler_lease_select ON public.happy_mission_task_leases;
CREATE POLICY happy_worker_scheduler_lease_select ON public.happy_mission_task_leases
  FOR SELECT TO happy_worker_scheduler_rpc_owner
  USING (private.happy_worker_tenant_scope_policy(organization_id,workspace_id,user_id,'CONTROL'));
DROP POLICY IF EXISTS happy_worker_scheduler_lease_insert ON public.happy_mission_task_leases;
CREATE POLICY happy_worker_scheduler_lease_insert ON public.happy_mission_task_leases
  FOR INSERT TO happy_worker_scheduler_rpc_owner
  WITH CHECK (
    private.happy_worker_tenant_scope_policy(organization_id,workspace_id,user_id,'CONTROL')
    AND attempt>=1 AND fencing_token>=1
  );
DROP POLICY IF EXISTS happy_worker_scheduler_lease_update ON public.happy_mission_task_leases;
CREATE POLICY happy_worker_scheduler_lease_update ON public.happy_mission_task_leases
  FOR UPDATE TO happy_worker_scheduler_rpc_owner
  USING (private.happy_worker_tenant_scope_policy(organization_id,workspace_id,user_id,'CONTROL'))
  WITH CHECK (private.happy_worker_tenant_scope_policy(organization_id,workspace_id,user_id,'CONTROL'));
GRANT SELECT ON public.happy_mission_task_leases TO happy_worker_scheduler_rpc_owner;
GRANT INSERT (
  organization_id,workspace_id,user_id,mission_id,task_id,
  lease_id,owner_id,attempt,fencing_token,expires_at
) ON public.happy_mission_task_leases TO happy_worker_scheduler_rpc_owner;
GRANT UPDATE (lease_id,owner_id,attempt,fencing_token,expires_at,updated_at)
  ON public.happy_mission_task_leases TO happy_worker_scheduler_rpc_owner;

-- Outbox CONTROL transitions and VERIFY-only row locks are separate policies.
DROP POLICY IF EXISTS happy_worker_scheduler_outbox_control_select ON public.happy_execution_dispatch_outbox;
CREATE POLICY happy_worker_scheduler_outbox_control_select ON public.happy_execution_dispatch_outbox
  FOR SELECT TO happy_worker_scheduler_rpc_owner
  USING (private.happy_worker_tenant_scope_policy(organization_id,workspace_id,user_id,'CONTROL'));
DROP POLICY IF EXISTS happy_worker_scheduler_outbox_verify_select ON public.happy_execution_dispatch_outbox;
CREATE POLICY happy_worker_scheduler_outbox_verify_select ON public.happy_execution_dispatch_outbox
  FOR SELECT TO happy_worker_scheduler_rpc_owner
  USING (private.happy_worker_tenant_scope_policy(organization_id,workspace_id,user_id,'VERIFY'));
DROP POLICY IF EXISTS happy_worker_scheduler_outbox_control_insert ON public.happy_execution_dispatch_outbox;
CREATE POLICY happy_worker_scheduler_outbox_control_insert ON public.happy_execution_dispatch_outbox
  FOR INSERT TO happy_worker_scheduler_rpc_owner
  WITH CHECK (
    private.happy_worker_tenant_scope_policy(organization_id,workspace_id,user_id,'CONTROL')
    AND status='PENDING' AND outcome='{}'::jsonb
  );
DROP POLICY IF EXISTS happy_worker_scheduler_outbox_control_update ON public.happy_execution_dispatch_outbox;
CREATE POLICY happy_worker_scheduler_outbox_control_update ON public.happy_execution_dispatch_outbox
  FOR UPDATE TO happy_worker_scheduler_rpc_owner
  USING (
    private.happy_worker_tenant_scope_policy(organization_id,workspace_id,user_id,'CONTROL')
    AND status IN ('PENDING','DISPATCHED')
  )
  WITH CHECK (
    private.happy_worker_tenant_scope_policy(organization_id,workspace_id,user_id,'CONTROL')
    AND status IN ('DISPATCHED','ACKNOWLEDGED','AMBIGUOUS','FAILED','RECONCILIATION_REQUIRED')
    AND jsonb_typeof(outcome)='object'
  );
DROP POLICY IF EXISTS happy_worker_scheduler_outbox_verify_lock ON public.happy_execution_dispatch_outbox;
CREATE POLICY happy_worker_scheduler_outbox_verify_lock ON public.happy_execution_dispatch_outbox
  FOR UPDATE TO happy_worker_scheduler_rpc_owner
  USING (
    private.happy_worker_tenant_scope_policy(organization_id,workspace_id,user_id,'VERIFY')
    AND status IN ('AMBIGUOUS','RECONCILIATION_REQUIRED')
  )
  WITH CHECK (false);

GRANT SELECT ON public.happy_execution_dispatch_outbox TO happy_worker_scheduler_rpc_owner;
GRANT INSERT (
  outbox_id,organization_id,workspace_id,user_id,mission_id,task_id,
  lease_id,fencing_token,attempt,execution_request_id,idempotency_key,
  capability,action,payload_digest,payload
) ON public.happy_execution_dispatch_outbox TO happy_worker_scheduler_rpc_owner;
GRANT UPDATE (status,outcome,updated_at)
  ON public.happy_execution_dispatch_outbox TO happy_worker_scheduler_rpc_owner;

-- Worker runtime may read only approved, founder-gated requests in its live
-- tenant scope, and may change only the execution status after dispatch.
DROP POLICY IF EXISTS happy_worker_scheduler_request_select ON private.execution_requests;
CREATE POLICY happy_worker_scheduler_request_select ON private.execution_requests
  FOR SELECT TO happy_worker_scheduler_rpc_owner
  USING (
    private.happy_worker_tenant_scope_policy(organization_id,workspace_id,executor_user_id,'CONTROL')
    AND requester_user_id=executor_user_id
    AND status IN ('READY','RUNNING')
    AND approval_status='APPROVED'
    AND requires_approval IS TRUE
    AND risk='HIGH'
    AND required_approval_role='FOUNDER'
    AND decided_by IS NOT NULL
    AND decided_by NOT IN (requester_user_id,executor_user_id)
    AND decided_at IS NOT NULL
  );
DROP POLICY IF EXISTS happy_worker_scheduler_request_update ON private.execution_requests;
CREATE POLICY happy_worker_scheduler_request_update ON private.execution_requests
  FOR UPDATE TO happy_worker_scheduler_rpc_owner
  USING (
    private.happy_worker_tenant_scope_policy(organization_id,workspace_id,executor_user_id,'CONTROL')
    AND requester_user_id=executor_user_id
    AND status IN ('READY','RUNNING')
    AND approval_status='APPROVED'
    AND requires_approval IS TRUE
    AND risk='HIGH'
    AND required_approval_role='FOUNDER'
    AND decided_by IS NOT NULL
    AND decided_by NOT IN (requester_user_id,executor_user_id)
    AND decided_at IS NOT NULL
  )
  WITH CHECK (
    private.happy_worker_tenant_scope_policy(organization_id,workspace_id,executor_user_id,'CONTROL')
    AND requester_user_id=executor_user_id
    AND status IN ('RUNNING','FAILED','BLOCKED')
    AND approval_status='APPROVED'
    AND requires_approval IS TRUE
    AND risk='HIGH'
    AND required_approval_role='FOUNDER'
    AND decided_by IS NOT NULL
    AND decided_by NOT IN (requester_user_id,executor_user_id)
    AND decided_at IS NOT NULL
  );
GRANT SELECT ON private.execution_requests TO happy_worker_scheduler_rpc_owner;
GRANT UPDATE (status) ON private.execution_requests TO happy_worker_scheduler_rpc_owner;

-- VERIFY-only append/read evidence. The outbox row is locked through the
-- separate VERIFY lock-only policy above; evidence itself is append-only.
DROP POLICY IF EXISTS happy_worker_scheduler_evidence_select ON public.happy_dispatch_reconciliation_evidence;
CREATE POLICY happy_worker_scheduler_evidence_select ON public.happy_dispatch_reconciliation_evidence
  FOR SELECT TO happy_worker_scheduler_rpc_owner
  USING (private.happy_worker_tenant_scope_policy(organization_id,workspace_id,user_id,'VERIFY'));
DROP POLICY IF EXISTS happy_worker_scheduler_evidence_insert ON public.happy_dispatch_reconciliation_evidence;
CREATE POLICY happy_worker_scheduler_evidence_insert ON public.happy_dispatch_reconciliation_evidence
  FOR INSERT TO happy_worker_scheduler_rpc_owner
  WITH CHECK (
    private.happy_worker_tenant_scope_policy(organization_id,workspace_id,user_id,'VERIFY')
    AND EXISTS (
      SELECT 1 FROM public.happy_execution_dispatch_outbox o
       WHERE o.organization_id=happy_dispatch_reconciliation_evidence.organization_id
         AND o.workspace_id=happy_dispatch_reconciliation_evidence.workspace_id
         AND o.user_id=happy_dispatch_reconciliation_evidence.user_id
         AND o.outbox_id=happy_dispatch_reconciliation_evidence.outbox_id
         AND o.status IN ('AMBIGUOUS','RECONCILIATION_REQUIRED')
         AND o.idempotency_key=happy_dispatch_reconciliation_evidence.idempotency_key
         AND o.outcome->>'provider'=happy_dispatch_reconciliation_evidence.provider_id
    )
  );
GRANT SELECT ON public.happy_dispatch_reconciliation_evidence TO happy_worker_scheduler_rpc_owner;
GRANT INSERT (
  evidence_id,organization_id,workspace_id,user_id,outbox_id,
  idempotency_key,provider_id,observation_status,observed_at,observation
) ON public.happy_dispatch_reconciliation_evidence TO happy_worker_scheduler_rpc_owner;

-- SECURITY DEFINER function ownership; the worker role itself never receives
-- direct table access or BYPASSRLS. CREATE is temporary for ALTER OWNER only.
GRANT CREATE ON SCHEMA private TO happy_worker_scheduler_rpc_owner;
ALTER FUNCTION private.happy_worker_claim_mission_task(uuid,uuid,uuid,uuid,text,text,text,integer)
  OWNER TO happy_worker_scheduler_rpc_owner;
ALTER FUNCTION private.happy_worker_enqueue_mission_dispatch(uuid,uuid,uuid,uuid,text,text,uuid,text,bigint,text,text,text,text,text,jsonb)
  OWNER TO happy_worker_scheduler_rpc_owner;
ALTER FUNCTION private.happy_worker_heartbeat_mission_task_lease(uuid,uuid,uuid,uuid,text,text,uuid,text,bigint,integer)
  OWNER TO happy_worker_scheduler_rpc_owner;
ALTER FUNCTION private.happy_worker_claim_dispatch_outbox(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint)
  OWNER TO happy_worker_scheduler_rpc_owner;
ALTER FUNCTION private.happy_worker_claim_next_dispatch_outbox(uuid,uuid,uuid,uuid,text)
  OWNER TO happy_worker_scheduler_rpc_owner;
ALTER FUNCTION private.happy_worker_record_dispatch_outcome(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint,text,jsonb)
  OWNER TO happy_worker_scheduler_rpc_owner;
ALTER FUNCTION private.happy_worker_append_dispatch_reconciliation_evidence(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,timestamptz,jsonb)
  OWNER TO happy_worker_scheduler_rpc_owner;
ALTER FUNCTION private.happy_worker_list_dispatch_reconciliation_evidence(uuid,uuid,uuid,uuid,uuid,text,text,text)
  OWNER TO happy_worker_scheduler_rpc_owner;
REVOKE CREATE ON SCHEMA private FROM happy_worker_scheduler_rpc_owner;

DO $assert$
DECLARE
  bad text;
  missing text;
BEGIN
  -- Pin the complete UPDATE-policy surface for every worker-owned relation.
  -- This catches missing policies and any extra policy that could silently
  -- broaden a SECURITY DEFINER owner's row visibility or mutation authority.
  WITH expected(schemaname, tablename, policyname, lock_only) AS (
    VALUES
      ('public','happy_tenant_records','happy_worker_scheduler_control_update',false),
      ('public','happy_mission_task_leases','happy_worker_scheduler_lease_update',false),
      ('public','happy_execution_dispatch_outbox','happy_worker_scheduler_outbox_control_update',false),
      ('public','happy_execution_dispatch_outbox','happy_worker_scheduler_outbox_verify_lock',true),
      ('private','execution_requests','happy_worker_scheduler_request_update',false)
  ),
  actual AS (
    SELECT schemaname, tablename, policyname, qual, with_check
      FROM pg_catalog.pg_policies
     WHERE cmd='UPDATE'
       AND 'happy_worker_scheduler_rpc_owner'=ANY(roles)
  ),
  missing_expected AS (
    SELECT e.schemaname||'.'||e.tablename||':'||e.policyname AS item
      FROM expected e
      LEFT JOIN actual a
        ON a.schemaname=e.schemaname
       AND a.tablename=e.tablename
       AND a.policyname=e.policyname
     WHERE a.policyname IS NULL
  ),
  unexpected AS (
    SELECT a.schemaname||'.'||a.tablename||':'||a.policyname AS item
      FROM actual a
      LEFT JOIN expected e
        ON e.schemaname=a.schemaname
       AND e.tablename=a.tablename
       AND e.policyname=a.policyname
     WHERE a.schemaname IN ('public','private')
       AND a.tablename IN (
         'happy_tenant_records','happy_mission_task_leases',
         'happy_execution_dispatch_outbox','execution_requests'
       )
       AND e.policyname IS NULL
  )
  SELECT string_agg(item, ', ') INTO missing FROM (
    SELECT item FROM missing_expected
    UNION ALL
    SELECT item FROM unexpected
  ) problems;
  IF missing IS NOT NULL THEN
    RAISE EXCEPTION 'Worker UPDATE policy set is incomplete or unexpectedly broad: %',missing;
  END IF;

  SELECT a.schemaname||'.'||a.tablename||':'||a.policyname
    INTO bad
    FROM pg_catalog.pg_policies a
    JOIN (VALUES
      ('public','happy_tenant_records','happy_worker_scheduler_control_update',false),
      ('public','happy_mission_task_leases','happy_worker_scheduler_lease_update',false),
      ('public','happy_execution_dispatch_outbox','happy_worker_scheduler_outbox_control_update',false),
      ('public','happy_execution_dispatch_outbox','happy_worker_scheduler_outbox_verify_lock',true),
      ('private','execution_requests','happy_worker_scheduler_request_update',false)
    ) e(schemaname,tablename,policyname,lock_only)
      ON e.schemaname=a.schemaname
     AND e.tablename=a.tablename
     AND e.policyname=a.policyname
   WHERE a.cmd='UPDATE'
     AND 'happy_worker_scheduler_rpc_owner'=ANY(a.roles)
     AND (
       coalesce(a.qual,'')=''
       OR (e.lock_only AND coalesce(a.with_check,'')<>'false')
       OR (NOT e.lock_only AND coalesce(a.with_check,'') IN ('','false'))
     )
   LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Worker UPDATE policy has an unsafe USING/WITH CHECK contract: %',bad;
  END IF;

  IF has_column_privilege('happy_worker_scheduler_rpc_owner','private.execution_requests','status','UPDATE') IS DISTINCT FROM true
     OR has_column_privilege('happy_worker_scheduler_rpc_owner','private.execution_requests','approval_status','UPDATE')
     OR has_column_privilege('happy_worker_scheduler_rpc_owner','private.execution_requests','decided_by','UPDATE')
     OR has_column_privilege('happy_worker_scheduler_rpc_owner','private.execution_requests','decision_reason','UPDATE') THEN
    RAISE EXCEPTION 'Worker request status grant is broader than intended';
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles granted ON granted.oid=m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid=m.member
    WHERE granted.rolname='happy_worker_scheduler_rpc_owner'
      AND (member.rolname IN ('anon','authenticated','service_role','authenticator')
        OR member.rolname LIKE 'happy_worker_%')
  ) THEN
    RAISE EXCEPTION 'API or worker LOGIN is a member of scheduler owner';
  END IF;
END;
$assert$;

COMMIT;
