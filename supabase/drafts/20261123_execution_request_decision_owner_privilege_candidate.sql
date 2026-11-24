-- DESIGN-ONLY founder-decision RPC owner grants and RLS.
-- Requires canonical identity baseline, JWT subject accessor, execution envelope
-- tables/functions, and happy_execution_request_decision_rpc_owner role.
-- DO NOT APPLY to a connected/shared/production project.
BEGIN;
GRANT USAGE ON SCHEMA private, public TO happy_execution_request_decision_rpc_owner;
GRANT EXECUTE ON FUNCTION private.happy_current_authenticated_user_id() TO happy_execution_request_decision_rpc_owner;

DO $identity_policies$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','workspaces','organization_memberships','workspace_memberships'] LOOP
    EXECUTE format('DROP POLICY IF EXISTS happy_execution_decision_owner_select ON private.%I',t);
    EXECUTE format('CREATE POLICY happy_execution_decision_owner_select ON private.%I FOR SELECT TO happy_execution_request_decision_rpc_owner USING (true)',t);
    EXECUTE format('DROP POLICY IF EXISTS happy_execution_decision_owner_lock ON private.%I',t);
    EXECUTE format('CREATE POLICY happy_execution_decision_owner_lock ON private.%I FOR UPDATE TO happy_execution_request_decision_rpc_owner USING (true) WITH CHECK (false)',t);
  END LOOP;
END
$identity_policies$;

GRANT SELECT ON private.organizations,private.workspaces,private.organization_memberships,private.workspace_memberships TO happy_execution_request_decision_rpc_owner;
GRANT UPDATE (status) ON private.organizations TO happy_execution_request_decision_rpc_owner;
GRANT UPDATE (status) ON private.workspaces TO happy_execution_request_decision_rpc_owner;
GRANT UPDATE (status) ON private.organization_memberships TO happy_execution_request_decision_rpc_owner;
GRANT UPDATE (status) ON private.workspace_memberships TO happy_execution_request_decision_rpc_owner;

CREATE OR REPLACE FUNCTION private.happy_is_active_founder_approval_scope(p_organization_id uuid,p_workspace_id uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $founder_scope$
  SELECT EXISTS (
    SELECT 1 FROM private.organizations o
    JOIN private.workspaces w ON w.organization_id=o.organization_id
    JOIN private.organization_memberships om ON om.organization_id=o.organization_id
    JOIN private.workspace_memberships wm ON wm.organization_id=w.organization_id AND wm.workspace_id=w.workspace_id AND wm.user_id=om.user_id
    WHERE o.organization_id=p_organization_id AND w.workspace_id=p_workspace_id
      AND om.user_id=private.happy_current_authenticated_user_id()
      AND om.status='ACTIVE' AND om.role='FOUNDER'
      AND wm.status='ACTIVE' AND wm.role IN ('FOUNDER','ADMIN','OWNER')
      AND o.status='ACTIVE' AND w.status='ACTIVE'
  );
$founder_scope$;
GRANT CREATE ON SCHEMA private TO happy_execution_request_decision_rpc_owner;
ALTER FUNCTION private.happy_is_active_founder_approval_scope(uuid,uuid) OWNER TO happy_execution_request_decision_rpc_owner;
REVOKE CREATE ON SCHEMA private FROM happy_execution_request_decision_rpc_owner;
REVOKE ALL ON FUNCTION private.happy_is_active_founder_approval_scope(uuid,uuid) FROM public,anon,authenticated,service_role;

DROP POLICY IF EXISTS happy_execution_decision_owner_select ON private.execution_requests;
CREATE POLICY happy_execution_decision_owner_select ON private.execution_requests
FOR SELECT TO happy_execution_request_decision_rpc_owner
USING (private.happy_is_active_founder_approval_scope(organization_id,workspace_id));

DROP POLICY IF EXISTS happy_execution_decision_owner_update ON private.execution_requests;
CREATE POLICY happy_execution_decision_owner_update ON private.execution_requests
FOR UPDATE TO happy_execution_request_decision_rpc_owner
USING (
  private.happy_is_active_founder_approval_scope(organization_id,workspace_id)
  AND requester_user_id<>private.happy_current_authenticated_user_id()
  AND status='WAITING_APPROVAL' AND approval_status='PENDING'
  AND required_approval_role='FOUNDER' AND requires_approval IS TRUE
)
WITH CHECK (
  private.happy_is_active_founder_approval_scope(organization_id,workspace_id)
  AND requester_user_id<>private.happy_current_authenticated_user_id()
  AND required_approval_role='FOUNDER' AND requires_approval IS TRUE
  AND approval_status IN ('APPROVED','REJECTED')
  AND decided_by=private.happy_current_authenticated_user_id()
  AND decided_at IS NOT NULL AND decision_reason IS NOT NULL
  AND length(btrim(decision_reason))>0
  AND status=CASE approval_status WHEN 'APPROVED' THEN 'READY' WHEN 'REJECTED' THEN 'CANCELLED' ELSE NULL END
);

GRANT SELECT ON private.execution_requests TO happy_execution_request_decision_rpc_owner;
GRANT UPDATE (approval_status,decided_at,decided_by,decision_reason,status)
  ON private.execution_requests TO happy_execution_request_decision_rpc_owner;

DROP POLICY IF EXISTS happy_execution_decision_event_insert ON private.execution_request_approval_events;
CREATE POLICY happy_execution_decision_event_insert ON private.execution_request_approval_events
FOR INSERT TO happy_execution_request_decision_rpc_owner
WITH CHECK (
  actor_user_id=private.happy_current_authenticated_user_id()
  AND EXISTS (
    SELECT 1 FROM private.execution_requests r
    WHERE r.request_id=execution_request_approval_events.request_id
      AND r.decided_by=private.happy_current_authenticated_user_id()
      AND r.approval_status=execution_request_approval_events.decision
      AND r.decision_reason=execution_request_approval_events.reason
      AND r.status=CASE execution_request_approval_events.decision WHEN 'APPROVED' THEN 'READY' WHEN 'REJECTED' THEN 'CANCELLED' ELSE NULL END
      AND private.happy_is_active_founder_approval_scope(r.organization_id,r.workspace_id)
  )
);
GRANT INSERT (request_id,actor_user_id,decision,reason,occurred_at)
  ON private.execution_request_approval_events TO happy_execution_request_decision_rpc_owner;

GRANT CREATE ON SCHEMA public TO happy_execution_request_decision_rpc_owner;
ALTER FUNCTION public.decide_authenticated_execution_request(text,text,text) OWNER TO happy_execution_request_decision_rpc_owner;
REVOKE CREATE ON SCHEMA public FROM happy_execution_request_decision_rpc_owner;
REVOKE ALL ON FUNCTION public.decide_authenticated_execution_request(text,text,text) FROM public,anon,service_role;
GRANT EXECUTE ON FUNCTION public.decide_authenticated_execution_request(text,text,text) TO authenticated;

DO $assert$
DECLARE bad text;
BEGIN
  SELECT format('%I.%I:%I',schemaname,tablename,policyname) INTO bad
  FROM pg_catalog.pg_policies
  WHERE schemaname='private'
    AND tablename IN ('organizations','workspaces','organization_memberships','workspace_memberships')
    AND cmd='UPDATE' AND 'happy_execution_request_decision_rpc_owner'=ANY(roles)
    AND (coalesce(qual,'')<>'true' OR coalesce(with_check,'')<>'false')
  LIMIT 1;
  IF bad IS NOT NULL THEN RAISE EXCEPTION 'Identity lock policy is not lock-only: %',bad; END IF;

  IF NOT has_column_privilege('happy_execution_request_decision_rpc_owner','private.execution_requests','approval_status','UPDATE')
     OR NOT has_column_privilege('happy_execution_request_decision_rpc_owner','private.execution_requests','decided_at','UPDATE')
     OR NOT has_column_privilege('happy_execution_request_decision_rpc_owner','private.execution_requests','decided_by','UPDATE')
     OR NOT has_column_privilege('happy_execution_request_decision_rpc_owner','private.execution_requests','decision_reason','UPDATE')
     OR NOT has_column_privilege('happy_execution_request_decision_rpc_owner','private.execution_requests','status','UPDATE')
     OR has_column_privilege('happy_execution_request_decision_rpc_owner','private.execution_requests','request_id','UPDATE')
     OR has_column_privilege('happy_execution_request_decision_rpc_owner','private.execution_requests','requester_user_id','UPDATE')
     OR has_column_privilege('happy_execution_request_decision_rpc_owner','private.execution_requests','executor_user_id','UPDATE') THEN
    RAISE EXCEPTION 'Execution request decision UPDATE columns are not exact';
  END IF;

  IF EXISTS (SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles granted ON granted.oid=m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid=m.member
    WHERE granted.rolname='happy_execution_request_decision_rpc_owner'
      AND (member.rolname IN ('anon','authenticated','service_role','authenticator') OR member.rolname LIKE 'happy_worker_%')) THEN
    RAISE EXCEPTION 'API or worker LOGIN is a member of execution request decision owner';
  END IF;
END
$assert$;
COMMIT;
