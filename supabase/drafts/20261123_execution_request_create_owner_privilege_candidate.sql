-- DESIGN-ONLY exact grants/RLS candidate for authenticated execution-request create/resolve.
-- Requires tenant scope owner candidate, JWT subject accessor, identity baseline,
-- happy_tenant_records, execution_requests, approval envelope and create-owner role.
-- DO NOT APPLY to a connected/shared/production project.
BEGIN;

GRANT USAGE ON SCHEMA private, public, extensions
  TO happy_execution_request_create_rpc_owner;
GRANT EXECUTE ON FUNCTION private.happy_current_authenticated_user_id()
  TO happy_execution_request_create_rpc_owner;
GRANT EXECUTE ON FUNCTION public.happy_has_active_tenant_scope(uuid,uuid)
  TO happy_execution_request_create_rpc_owner;
GRANT EXECUTE ON FUNCTION extensions.digest(bytea,text)
  TO happy_execution_request_create_rpc_owner;

-- Read only the same user's persisted mission/task snapshots.
DROP POLICY IF EXISTS happy_tenant_records_execution_create_select
  ON public.happy_tenant_records;
CREATE POLICY happy_tenant_records_execution_create_select
  ON public.happy_tenant_records
  FOR SELECT TO happy_execution_request_create_rpc_owner
  USING (
    user_id = private.happy_current_authenticated_user_id()
    AND public.happy_has_active_tenant_scope(organization_id,workspace_id)
  );
GRANT SELECT (organization_id,workspace_id,user_id,entity_type,record_id,data)
  ON public.happy_tenant_records
  TO happy_execution_request_create_rpc_owner;

-- The create/resolve owner can see only the caller's own active-scope request
-- rows. New rows must be inert, self-executed and pending founder approval.
DROP POLICY IF EXISTS happy_execution_request_create_owner_select
  ON private.execution_requests;
CREATE POLICY happy_execution_request_create_owner_select
  ON private.execution_requests
  FOR SELECT TO happy_execution_request_create_rpc_owner
  USING (
    requester_user_id = private.happy_current_authenticated_user_id()
    AND public.happy_has_active_tenant_scope(organization_id,workspace_id)
  );

DROP POLICY IF EXISTS happy_execution_request_create_owner_insert
  ON private.execution_requests;
CREATE POLICY happy_execution_request_create_owner_insert
  ON private.execution_requests
  FOR INSERT TO happy_execution_request_create_rpc_owner
  WITH CHECK (
    requester_user_id = private.happy_current_authenticated_user_id()
    AND executor_user_id = private.happy_current_authenticated_user_id()
    AND status = 'WAITING_APPROVAL'
    AND requires_approval IS TRUE
    AND risk = 'HIGH'
    AND approval_status = 'PENDING'
    AND required_approval_role = 'FOUNDER'
    AND decided_at IS NULL
    AND decided_by IS NULL
    AND decision_reason IS NULL
    AND public.happy_has_active_tenant_scope(organization_id,workspace_id)
  );

GRANT SELECT ON private.execution_requests
  TO happy_execution_request_create_rpc_owner;
GRANT INSERT (
  request_id,task_id,mission_id,requester_user_id,executor_user_id,
  organization_id,workspace_id,status,capability,action,input,target_reference,
  requires_approval,risk,approval_status,required_approval_role,
  input_digest,envelope_digest,idempotency_key
) ON private.execution_requests
  TO happy_execution_request_create_rpc_owner;

-- The owner is NOLOGIN/NOBYPASSRLS. CREATE is temporary for function owner transfer.
GRANT CREATE ON SCHEMA public TO happy_execution_request_create_rpc_owner;
ALTER FUNCTION public.create_authenticated_execution_request(text,text,text,uuid,uuid,text,text,jsonb,jsonb,text)
  OWNER TO happy_execution_request_create_rpc_owner;
ALTER FUNCTION public.resolve_authenticated_execution_request(text)
  OWNER TO happy_execution_request_create_rpc_owner;
REVOKE CREATE ON SCHEMA public FROM happy_execution_request_create_rpc_owner;

REVOKE ALL ON FUNCTION public.create_authenticated_execution_request(text,text,text,uuid,uuid,text,text,jsonb,jsonb,text)
  FROM public,anon,service_role;
GRANT EXECUTE ON FUNCTION public.create_authenticated_execution_request(text,text,text,uuid,uuid,text,text,jsonb,jsonb,text)
  TO authenticated;
REVOKE ALL ON FUNCTION public.resolve_authenticated_execution_request(text)
  FROM public,anon,service_role;
GRANT EXECUTE ON FUNCTION public.resolve_authenticated_execution_request(text)
  TO authenticated;

DO $assert$
DECLARE v_bad text;
BEGIN
  IF NOT has_table_privilege('happy_execution_request_create_rpc_owner',
       'private.execution_requests','SELECT')
     OR has_table_privilege('happy_execution_request_create_rpc_owner',
       'private.execution_requests','UPDATE')
     OR has_table_privilege('happy_execution_request_create_rpc_owner',
       'private.execution_requests','DELETE') THEN
    RAISE EXCEPTION 'Execution request create owner has unexpected table privileges';
  END IF;

  SELECT pg_catalog.pg_get_userbyid(p.proowner)
    INTO v_bad
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='public'
     AND p.proname='create_authenticated_execution_request';
  IF v_bad <> 'happy_execution_request_create_rpc_owner' THEN
    RAISE EXCEPTION 'Create RPC owner mismatch: %',v_bad;
  END IF;

  IF EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles granted ON granted.oid=m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid=m.member
    WHERE granted.rolname='happy_execution_request_create_rpc_owner'
      AND (member.rolname IN ('anon','authenticated','service_role','authenticator')
        OR member.rolname LIKE 'happy_worker_%')
  ) THEN
    RAISE EXCEPTION 'API or worker LOGIN is a member of execution request create owner';
  END IF;
END
$assert$;

COMMIT;
