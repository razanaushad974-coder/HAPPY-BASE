-- Disposable execution-request decision owner / founder RLS probe.
-- Supabase PostgreSQL 17.12; isolated rollback-only synthetic fixture.
-- Tests FOR UPDATE locks, founder scope, immutable decision fields and append-only evidence.
BEGIN;

CREATE ROLE happy_execution_request_decision_owner_probe
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT happy_execution_request_decision_owner_probe TO postgres;
CREATE SCHEMA happy_exec_decision_probe;
GRANT USAGE,CREATE ON SCHEMA happy_exec_decision_probe TO happy_execution_request_decision_owner_probe;
GRANT USAGE ON SCHEMA happy_exec_decision_probe TO authenticated;

CREATE FUNCTION happy_exec_decision_probe.current_user_id()
RETURNS uuid LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $uid$ SELECT auth.uid() $uid$;
REVOKE ALL ON FUNCTION happy_exec_decision_probe.current_user_id() FROM PUBLIC,anon,authenticated,service_role;
GRANT EXECUTE ON FUNCTION happy_exec_decision_probe.current_user_id() TO happy_execution_request_decision_owner_probe;

CREATE TABLE happy_exec_decision_probe.organizations(organization_id uuid PRIMARY KEY,status text NOT NULL);
CREATE TABLE happy_exec_decision_probe.workspaces(organization_id uuid NOT NULL,workspace_id uuid NOT NULL,status text NOT NULL,PRIMARY KEY(organization_id,workspace_id));
CREATE TABLE happy_exec_decision_probe.organization_memberships(organization_id uuid NOT NULL,user_id uuid NOT NULL,status text NOT NULL,role text NOT NULL,PRIMARY KEY(organization_id,user_id));
CREATE TABLE happy_exec_decision_probe.workspace_memberships(organization_id uuid NOT NULL,workspace_id uuid NOT NULL,user_id uuid NOT NULL,status text NOT NULL,role text NOT NULL,PRIMARY KEY(organization_id,workspace_id,user_id));
CREATE TABLE happy_exec_decision_probe.execution_requests(
 request_id text PRIMARY KEY, requester_user_id uuid NOT NULL, executor_user_id uuid NOT NULL,
 organization_id uuid NOT NULL, workspace_id uuid NOT NULL, status text NOT NULL,
 requires_approval boolean NOT NULL, approval_status text NOT NULL,
 required_approval_role text NOT NULL, decided_at timestamptz, decided_by uuid, decision_reason text
);
CREATE TABLE happy_exec_decision_probe.approval_events(
 event_id uuid PRIMARY KEY DEFAULT gen_random_uuid(), request_id text NOT NULL UNIQUE,
 actor_user_id uuid NOT NULL, decision text NOT NULL, reason text NOT NULL, occurred_at timestamptz NOT NULL
);

INSERT INTO happy_exec_decision_probe.organizations VALUES ('00000000-0000-0000-0000-000000000002','ACTIVE');
INSERT INTO happy_exec_decision_probe.workspaces VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','ACTIVE');
INSERT INTO happy_exec_decision_probe.organization_memberships VALUES
 ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000004','ACTIVE','MEMBER'),
 ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000005','ACTIVE','FOUNDER'),
 ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000006','ACTIVE','MEMBER');
INSERT INTO happy_exec_decision_probe.workspace_memberships VALUES
 ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','ACTIVE','MEMBER'),
 ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000005','ACTIVE','FOUNDER'),
 ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000006','ACTIVE','MEMBER');
INSERT INTO happy_exec_decision_probe.execution_requests VALUES
 ('req-1','00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','WAITING_APPROVAL',true,'PENDING','FOUNDER',null,null,null),
 ('req-2','00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000005','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','WAITING_APPROVAL',true,'PENDING','FOUNDER',null,null,null),
 ('req-3','00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','WAITING_APPROVAL',true,'PENDING','FOUNDER',null,null,null);

DO $rls$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['organizations','workspaces','organization_memberships','workspace_memberships'] LOOP
  EXECUTE format('ALTER TABLE happy_exec_decision_probe.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY owner_select ON happy_exec_decision_probe.%I FOR SELECT TO happy_execution_request_decision_owner_probe USING (true)',t);
  EXECUTE format('CREATE POLICY owner_lock_only ON happy_exec_decision_probe.%I FOR UPDATE TO happy_execution_request_decision_owner_probe USING (true) WITH CHECK (false)',t);
 END LOOP;
END
$rls$;
ALTER TABLE happy_exec_decision_probe.execution_requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE happy_exec_decision_probe.approval_events ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON happy_exec_decision_probe.organizations, happy_exec_decision_probe.workspaces,
 happy_exec_decision_probe.organization_memberships, happy_exec_decision_probe.workspace_memberships
 TO happy_execution_request_decision_owner_probe;
GRANT UPDATE(status) ON happy_exec_decision_probe.organizations TO happy_execution_request_decision_owner_probe;
GRANT UPDATE(status) ON happy_exec_decision_probe.workspaces TO happy_execution_request_decision_owner_probe;
GRANT UPDATE(status) ON happy_exec_decision_probe.organization_memberships TO happy_execution_request_decision_owner_probe;
GRANT UPDATE(status) ON happy_exec_decision_probe.workspace_memberships TO happy_execution_request_decision_owner_probe;
GRANT SELECT ON happy_exec_decision_probe.execution_requests TO happy_execution_request_decision_owner_probe;
GRANT UPDATE(approval_status,decided_at,decided_by,decision_reason,status)
 ON happy_exec_decision_probe.execution_requests TO happy_execution_request_decision_owner_probe;
GRANT INSERT(request_id,actor_user_id,decision,reason,occurred_at)
 ON happy_exec_decision_probe.approval_events TO happy_execution_request_decision_owner_probe;

CREATE FUNCTION happy_exec_decision_probe.founder_scope(p_org uuid,p_workspace uuid)
RETURNS boolean LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $founder$
 SELECT EXISTS (
  SELECT 1 FROM happy_exec_decision_probe.organizations o
  JOIN happy_exec_decision_probe.workspaces w ON w.organization_id=o.organization_id
  JOIN happy_exec_decision_probe.organization_memberships om ON om.organization_id=o.organization_id
  JOIN happy_exec_decision_probe.workspace_memberships wm ON wm.organization_id=w.organization_id AND wm.workspace_id=w.workspace_id AND wm.user_id=om.user_id
  WHERE o.organization_id=p_org AND w.workspace_id=p_workspace
    AND om.user_id=happy_exec_decision_probe.current_user_id()
    AND om.status='ACTIVE' AND om.role='FOUNDER'
    AND wm.status='ACTIVE' AND wm.role IN ('FOUNDER','ADMIN','OWNER')
    AND o.status='ACTIVE' AND w.status='ACTIVE'
 );
$founder$;

CREATE POLICY request_select ON happy_exec_decision_probe.execution_requests
 FOR SELECT TO happy_execution_request_decision_owner_probe
 USING (happy_exec_decision_probe.founder_scope(organization_id,workspace_id));
CREATE POLICY request_update ON happy_exec_decision_probe.execution_requests
 FOR UPDATE TO happy_execution_request_decision_owner_probe
 USING (happy_exec_decision_probe.founder_scope(organization_id,workspace_id)
  AND requester_user_id<>happy_exec_decision_probe.current_user_id()
  AND status='WAITING_APPROVAL' AND approval_status='PENDING'
  AND required_approval_role='FOUNDER' AND requires_approval)
 WITH CHECK (happy_exec_decision_probe.founder_scope(organization_id,workspace_id)
  AND requester_user_id<>happy_exec_decision_probe.current_user_id()
  AND approval_status IN ('APPROVED','REJECTED')
  AND decided_by=happy_exec_decision_probe.current_user_id()
  AND decided_at IS NOT NULL AND decision_reason IS NOT NULL AND length(btrim(decision_reason))>0
  AND status=CASE approval_status WHEN 'APPROVED' THEN 'READY' WHEN 'REJECTED' THEN 'CANCELLED' ELSE NULL END);

CREATE POLICY event_insert ON happy_exec_decision_probe.approval_events
 FOR INSERT TO happy_execution_request_decision_owner_probe
 WITH CHECK (actor_user_id=happy_exec_decision_probe.current_user_id()
  AND EXISTS (SELECT 1 FROM happy_exec_decision_probe.execution_requests r
   WHERE r.request_id=approval_events.request_id
    AND r.decided_by=happy_exec_decision_probe.current_user_id()
    AND r.approval_status=approval_events.decision
    AND r.decision_reason=approval_events.reason
    AND r.status=CASE approval_events.decision WHEN 'APPROVED' THEN 'READY' WHEN 'REJECTED' THEN 'CANCELLED' ELSE NULL END
    AND happy_exec_decision_probe.founder_scope(r.organization_id,r.workspace_id)));

CREATE FUNCTION happy_exec_decision_probe.decide(p_request_id text,p_decision text,p_reason text)
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $decide$
DECLARE actor uuid:=happy_exec_decision_probe.current_user_id();
        req happy_exec_decision_probe.execution_requests%rowtype;
        orgrow happy_exec_decision_probe.organizations%rowtype;
        wsrow happy_exec_decision_probe.workspaces%rowtype;
        m record;
        wm record;
BEGIN
 IF actor IS NULL OR p_decision NOT IN ('APPROVED','REJECTED') OR p_reason IS NULL OR length(btrim(p_reason))=0 THEN RETURN false; END IF;
 SELECT o.* INTO orgrow FROM happy_exec_decision_probe.organizations o
 JOIN happy_exec_decision_probe.execution_requests r ON r.organization_id=o.organization_id
 WHERE r.request_id=p_request_id FOR UPDATE OF o;
 IF NOT FOUND OR orgrow.status<>'ACTIVE' THEN RETURN false; END IF;
 SELECT w.* INTO wsrow FROM happy_exec_decision_probe.workspaces w
 JOIN happy_exec_decision_probe.execution_requests r ON r.organization_id=w.organization_id AND r.workspace_id=w.workspace_id
 WHERE r.request_id=p_request_id FOR UPDATE OF w;
 IF NOT FOUND OR wsrow.status<>'ACTIVE' THEN RETURN false; END IF;
 SELECT r.* INTO req FROM happy_exec_decision_probe.execution_requests r WHERE r.request_id=p_request_id FOR UPDATE;
 IF NOT FOUND OR req.status<>'WAITING_APPROVAL' OR req.approval_status<>'PENDING'
   OR req.required_approval_role<>'FOUNDER' OR NOT req.requires_approval
   OR req.requester_user_id=actor THEN RETURN false; END IF;
 FOR m IN SELECT * FROM happy_exec_decision_probe.organization_memberships
   WHERE organization_id=req.organization_id AND user_id IN (req.requester_user_id,actor)
   ORDER BY user_id FOR UPDATE LOOP
   IF m.user_id=actor AND (m.status<>'ACTIVE' OR m.role<>'FOUNDER') THEN RETURN false; END IF;
   IF m.user_id=req.requester_user_id AND m.status<>'ACTIVE' THEN RETURN false; END IF;
 END LOOP;
 FOR wm IN SELECT * FROM happy_exec_decision_probe.workspace_memberships
   WHERE organization_id=req.organization_id AND workspace_id=req.workspace_id
     AND user_id IN (req.requester_user_id,actor)
   ORDER BY user_id FOR UPDATE LOOP
   IF wm.user_id=actor AND (wm.status<>'ACTIVE' OR wm.role NOT IN ('FOUNDER','ADMIN','OWNER')) THEN RETURN false; END IF;
   IF wm.user_id=req.requester_user_id AND wm.status<>'ACTIVE' THEN RETURN false; END IF;
 END LOOP;
 UPDATE happy_exec_decision_probe.execution_requests
  SET approval_status=p_decision,decided_at=clock_timestamp(),decided_by=actor,
      decision_reason=btrim(p_reason),status=CASE WHEN p_decision='APPROVED' THEN 'READY' ELSE 'CANCELLED' END
  WHERE request_id=p_request_id AND status='WAITING_APPROVAL' AND approval_status='PENDING';
 IF NOT FOUND THEN RETURN false; END IF;
 INSERT INTO happy_exec_decision_probe.approval_events(request_id,actor_user_id,decision,reason,occurred_at)
 VALUES(p_request_id,actor,p_decision,btrim(p_reason),clock_timestamp());
 RETURN true;
END
$decide$;

ALTER FUNCTION happy_exec_decision_probe.founder_scope(uuid,uuid) OWNER TO happy_execution_request_decision_owner_probe;
ALTER FUNCTION happy_exec_decision_probe.decide(text,text,text) OWNER TO happy_execution_request_decision_owner_probe;
REVOKE CREATE ON SCHEMA happy_exec_decision_probe FROM happy_execution_request_decision_owner_probe;
REVOKE ALL ON FUNCTION happy_exec_decision_probe.decide(text,text,text) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION happy_exec_decision_probe.decide(text,text,text) TO authenticated;

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000005',true);
SET LOCAL ROLE authenticated;
DO $calls$
DECLARE ok boolean;
BEGIN
 ok:=happy_exec_decision_probe.decide('req-1','APPROVED','founder approval');
 IF ok IS DISTINCT FROM true THEN RAISE EXCEPTION 'valid founder approval failed'; END IF;
 ok:=happy_exec_decision_probe.decide('req-2','APPROVED','self approval');
 IF ok IS DISTINCT FROM false THEN RAISE EXCEPTION 'self approval was not denied'; END IF;
END
$calls$;
RESET ROLE;

SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000006',true);
SET LOCAL ROLE authenticated;
DO $nonfounder$
BEGIN
 IF happy_exec_decision_probe.decide('req-3','APPROVED','member approval') IS DISTINCT FROM false THEN
  RAISE EXCEPTION 'non-founder approval was not denied';
 END IF;
END
$nonfounder$;
RESET ROLE;

DO $verify$
DECLARE status_value text; decision_value text; event_count bigint;
BEGIN
 SELECT status,approval_status INTO status_value,decision_value
 FROM happy_exec_decision_probe.execution_requests WHERE request_id='req-1';
 IF status_value<>'READY' OR decision_value<>'APPROVED' THEN RAISE EXCEPTION 'request state incorrect'; END IF;
 SELECT count(*) INTO event_count FROM happy_exec_decision_probe.approval_events WHERE request_id='req-1';
 IF event_count<>1 THEN RAISE EXCEPTION 'approval evidence missing or duplicated'; END IF;
END
$verify$;

ROLLBACK;
