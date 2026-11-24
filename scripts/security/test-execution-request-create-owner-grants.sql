-- Disposable execution-request create/resolve owner RLS probe.
-- Supabase PostgreSQL 17.12; synthetic tenant and request tables; full rollback.
BEGIN;

CREATE ROLE happy_execution_request_create_owner_probe
 NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT happy_execution_request_create_owner_probe TO postgres;
CREATE SCHEMA happy_exec_create_probe;
GRANT USAGE,CREATE ON SCHEMA happy_exec_create_probe TO happy_execution_request_create_owner_probe;
GRANT USAGE ON SCHEMA happy_exec_create_probe TO authenticated;
GRANT USAGE ON SCHEMA extensions TO happy_execution_request_create_owner_probe;
GRANT EXECUTE ON FUNCTION extensions.digest(bytea,text) TO happy_execution_request_create_owner_probe;

CREATE FUNCTION happy_exec_create_probe.current_user_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $uid$ SELECT auth.uid() $uid$;
REVOKE ALL ON FUNCTION happy_exec_create_probe.current_user_id() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION happy_exec_create_probe.current_user_id() TO happy_execution_request_create_owner_probe;

CREATE TABLE happy_exec_create_probe.organizations(organization_id uuid PRIMARY KEY,status text NOT NULL);
CREATE TABLE happy_exec_create_probe.workspaces(organization_id uuid NOT NULL,workspace_id uuid NOT NULL,status text NOT NULL,PRIMARY KEY(organization_id,workspace_id));
CREATE TABLE happy_exec_create_probe.organization_memberships(organization_id uuid NOT NULL,user_id uuid NOT NULL,status text NOT NULL,PRIMARY KEY(organization_id,user_id));
CREATE TABLE happy_exec_create_probe.workspace_memberships(organization_id uuid NOT NULL,workspace_id uuid NOT NULL,user_id uuid NOT NULL,status text NOT NULL,PRIMARY KEY(organization_id,workspace_id,user_id));
CREATE TABLE happy_exec_create_probe.tenant_records(
 organization_id uuid NOT NULL,workspace_id uuid NOT NULL,user_id uuid NOT NULL,
 entity_type text NOT NULL,record_id text NOT NULL,version bigint NOT NULL DEFAULT 1,
 data jsonb NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,workspace_id,user_id,entity_type,record_id)
);
CREATE TABLE happy_exec_create_probe.execution_requests(
 request_id text PRIMARY KEY,task_id text NOT NULL,mission_id text NOT NULL,
 requester_user_id uuid NOT NULL,executor_user_id uuid NOT NULL,
 organization_id uuid NOT NULL,workspace_id uuid NOT NULL,status text NOT NULL,
 capability text NOT NULL,action text NOT NULL,input jsonb NOT NULL,target_reference jsonb,
 requires_approval boolean NOT NULL,risk text NOT NULL,approval_status text NOT NULL,
 required_approval_role text NOT NULL,input_digest text NOT NULL,envelope_digest text NOT NULL,
 idempotency_key text NOT NULL,created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
 decided_at timestamptz,decided_by uuid,decision_reason text,
 UNIQUE(requester_user_id,organization_id,workspace_id,idempotency_key)
);

INSERT INTO happy_exec_create_probe.organizations VALUES ('00000000-0000-0000-0000-000000000002','ACTIVE');
INSERT INTO happy_exec_create_probe.workspaces VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','ACTIVE');
INSERT INTO happy_exec_create_probe.organization_memberships VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000004','ACTIVE');
INSERT INTO happy_exec_create_probe.workspace_memberships VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','ACTIVE');
INSERT INTO happy_exec_create_probe.tenant_records VALUES
 ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','MISSION','mission-1',1,'{"id":"mission-1","status":"READY","taskIds":["task-1"]}'::jsonb,clock_timestamp(),clock_timestamp()),
 ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','TASK','task-1',1,'{"id":"task-1","missionId":"mission-1","status":"READY"}'::jsonb,clock_timestamp(),clock_timestamp());

DO $rls$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['organizations','workspaces','organization_memberships','workspace_memberships'] LOOP
  EXECUTE format('ALTER TABLE happy_exec_create_probe.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY active_scope_select ON happy_exec_create_probe.%I FOR SELECT TO happy_execution_request_create_owner_probe USING (true)',t);
 END LOOP;
END
$rls$;

ALTER TABLE happy_exec_create_probe.tenant_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE happy_exec_create_probe.execution_requests ENABLE ROW LEVEL SECURITY;

CREATE FUNCTION happy_exec_create_probe.active_scope(p_org uuid,p_workspace uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $scope$
 SELECT EXISTS(
  SELECT 1 FROM happy_exec_create_probe.organizations o
  JOIN happy_exec_create_probe.workspaces w ON w.organization_id=o.organization_id
  JOIN happy_exec_create_probe.organization_memberships om ON om.organization_id=o.organization_id
  JOIN happy_exec_create_probe.workspace_memberships wm ON wm.organization_id=w.organization_id AND wm.workspace_id=w.workspace_id AND wm.user_id=om.user_id
  WHERE o.organization_id=p_org AND w.workspace_id=p_workspace
   AND om.user_id=happy_exec_create_probe.current_user_id()
   AND o.status='ACTIVE' AND w.status='ACTIVE' AND om.status='ACTIVE' AND wm.status='ACTIVE'
 );
$scope$;

GRANT EXECUTE ON FUNCTION happy_exec_create_probe.active_scope(uuid,uuid) TO happy_execution_request_create_owner_probe;
GRANT SELECT(organization_id,workspace_id,user_id,entity_type,record_id,data)
 ON happy_exec_create_probe.tenant_records TO happy_execution_request_create_owner_probe;
CREATE POLICY create_owner_tenant_read ON happy_exec_create_probe.tenant_records
 FOR SELECT TO happy_execution_request_create_owner_probe
 USING (user_id=happy_exec_create_probe.current_user_id() AND happy_exec_create_probe.active_scope(organization_id,workspace_id));

GRANT SELECT ON happy_exec_create_probe.execution_requests TO happy_execution_request_create_owner_probe;
GRANT INSERT(request_id,task_id,mission_id,requester_user_id,executor_user_id,organization_id,workspace_id,status,capability,action,input,target_reference,requires_approval,risk,approval_status,required_approval_role,input_digest,envelope_digest,idempotency_key)
 ON happy_exec_create_probe.execution_requests TO happy_execution_request_create_owner_probe;

CREATE POLICY request_owner_select ON happy_exec_create_probe.execution_requests
 FOR SELECT TO happy_execution_request_create_owner_probe
 USING (requester_user_id=happy_exec_create_probe.current_user_id() AND happy_exec_create_probe.active_scope(organization_id,workspace_id));
CREATE POLICY request_owner_insert ON happy_exec_create_probe.execution_requests
 FOR INSERT TO happy_execution_request_create_owner_probe
 WITH CHECK (
  requester_user_id=happy_exec_create_probe.current_user_id()
  AND executor_user_id=happy_exec_create_probe.current_user_id()
  AND status='WAITING_APPROVAL' AND requires_approval
  AND risk='HIGH' AND approval_status='PENDING' AND required_approval_role='FOUNDER'
  AND decided_at IS NULL AND decided_by IS NULL AND decision_reason IS NULL
  AND happy_exec_create_probe.active_scope(organization_id,workspace_id)
 );

CREATE FUNCTION happy_exec_create_probe.create_request(p_request_id text,p_task_id text,p_mission_id text,p_org uuid,p_workspace uuid,p_capability text,p_action text,p_input jsonb,p_idempotency text)
RETURNS text LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $create$
DECLARE actor uuid:=happy_exec_create_probe.current_user_id(); mission jsonb; task jsonb; digest_value text; existing happy_exec_create_probe.execution_requests%rowtype;
BEGIN
 IF actor IS NULL OR NOT happy_exec_create_probe.active_scope(p_org,p_workspace) THEN RAISE EXCEPTION 'TENANT_ACCESS_DENIED'; END IF;
 SELECT data INTO mission FROM happy_exec_create_probe.tenant_records
  WHERE organization_id=p_org AND workspace_id=p_workspace AND user_id=actor AND entity_type='MISSION' AND record_id=p_mission_id;
 IF NOT FOUND OR mission->>'id'<>p_mission_id OR NOT ((mission->'taskIds') ? p_task_id) THEN RAISE EXCEPTION 'MISSION_NOT_FOUND_OR_TASK_NOT_BOUND'; END IF;
 SELECT data INTO task FROM happy_exec_create_probe.tenant_records
  WHERE organization_id=p_org AND workspace_id=p_workspace AND user_id=actor AND entity_type='TASK' AND record_id=p_task_id;
 IF NOT FOUND OR task->>'missionId'<>p_mission_id THEN RAISE EXCEPTION 'TASK_NOT_FOUND_OR_MISSION_MISMATCH'; END IF;
 digest_value:=encode(extensions.digest(convert_to(p_input::text,'UTF8'),'sha256'),'hex');
 INSERT INTO happy_exec_create_probe.execution_requests(
  request_id,task_id,mission_id,requester_user_id,executor_user_id,organization_id,workspace_id,status,
  capability,action,input,requires_approval,risk,approval_status,required_approval_role,input_digest,envelope_digest,idempotency_key
 ) VALUES(p_request_id,p_task_id,p_mission_id,actor,actor,p_org,p_workspace,'WAITING_APPROVAL',
  p_capability,p_action,p_input,true,'HIGH','PENDING','FOUNDER',digest_value,digest_value,p_idempotency)
 ON CONFLICT(requester_user_id,organization_id,workspace_id,idempotency_key) DO NOTHING;
 SELECT * INTO existing FROM happy_exec_create_probe.execution_requests
  WHERE requester_user_id=actor AND organization_id=p_org AND workspace_id=p_workspace AND idempotency_key=p_idempotency;
 IF NOT FOUND THEN RAISE EXCEPTION 'REQUEST_PERSISTENCE_FAILED'; END IF;
 IF existing.task_id<>p_task_id OR existing.mission_id<>p_mission_id OR existing.input<>p_input OR existing.capability<>p_capability OR existing.action<>p_action THEN
  RAISE EXCEPTION 'IDEMPOTENCY_KEY_REUSED_WITH_DIFFERENT_EXECUTION';
 END IF;
 RETURN existing.request_id;
END
$create$;

CREATE FUNCTION happy_exec_create_probe.resolve_request(p_request_id text)
RETURNS text LANGUAGE sql SECURITY DEFINER SET search_path=pg_catalog
AS $resolve$
 SELECT r.request_id FROM happy_exec_create_probe.execution_requests r
 WHERE r.request_id=p_request_id AND r.executor_user_id=happy_exec_create_probe.current_user_id() AND r.capability IS NOT NULL
 LIMIT 1;
$resolve$;

ALTER FUNCTION happy_exec_create_probe.create_request(text,text,text,uuid,uuid,text,text,jsonb,text) OWNER TO happy_execution_request_create_owner_probe;
ALTER FUNCTION happy_exec_create_probe.resolve_request(text) OWNER TO happy_execution_request_create_owner_probe;
REVOKE CREATE ON SCHEMA happy_exec_create_probe FROM happy_execution_request_create_owner_probe;
REVOKE ALL ON FUNCTION happy_exec_create_probe.create_request(text,text,text,uuid,uuid,text,text,jsonb,text) FROM PUBLIC;
REVOKE ALL ON FUNCTION happy_exec_create_probe.resolve_request(text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION happy_exec_create_probe.create_request(text,text,text,uuid,uuid,text,text,jsonb,text) TO authenticated;
GRANT EXECUTE ON FUNCTION happy_exec_create_probe.resolve_request(text) TO authenticated;

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004',true);
SET LOCAL ROLE authenticated;
DO $test$
DECLARE first_id text; retry_id text; resolved text;
BEGIN
 first_id:=happy_exec_create_probe.create_request('req-1','task-1','mission-1',
  '00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',
  'CODE','execute','{"command":"test"}'::jsonb,'idem-1');
 retry_id:=happy_exec_create_probe.create_request('req-2','task-1','mission-1',
  '00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',
  'CODE','execute','{"command":"test"}'::jsonb,'idem-1');
 IF first_id<>'req-1' OR retry_id<>'req-1' THEN RAISE EXCEPTION 'idempotent create did not return persisted request'; END IF;
 resolved:=happy_exec_create_probe.resolve_request('req-1');
 IF resolved<>'req-1' THEN RAISE EXCEPTION 'own request resolution failed'; END IF;
 PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000005',true);
 resolved:=happy_exec_create_probe.resolve_request('req-1');
 IF resolved IS NOT NULL THEN RAISE EXCEPTION 'cross-user request resolution leaked'; END IF;
END
$test$;
RESET ROLE;
ROLLBACK;
