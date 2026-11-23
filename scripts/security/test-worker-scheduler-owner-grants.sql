-- Disposable worker scheduler owner / RLS capability matrix probe.
-- Supabase PostgreSQL 17.12. Uses session_user=postgres as a synthetic registered
-- worker principal only inside this rollback transaction; not a production identity test.
BEGIN;

CREATE ROLE happy_worker_registry_owner_probe NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE happy_worker_scheduler_owner_probe NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT happy_worker_registry_owner_probe TO postgres;
GRANT happy_worker_scheduler_owner_probe TO postgres;

CREATE SCHEMA happy_worker_sched_probe;
GRANT USAGE,CREATE ON SCHEMA happy_worker_sched_probe TO happy_worker_registry_owner_probe;
GRANT USAGE,CREATE ON SCHEMA happy_worker_sched_probe TO happy_worker_scheduler_owner_probe;
GRANT USAGE ON SCHEMA happy_worker_sched_probe TO authenticated;

CREATE TABLE happy_worker_sched_probe.principal_registry(
 worker_principal_id uuid PRIMARY KEY,db_login_role text NOT NULL,capabilities text[] NOT NULL,
 enabled boolean NOT NULL,activated_at timestamptz,revoked_at timestamptz
);
CREATE TABLE happy_worker_sched_probe.tenant_grants(
 worker_principal_id uuid NOT NULL,organization_id uuid NOT NULL,workspace_id uuid NOT NULL,
 user_id uuid NOT NULL,capabilities text[] NOT NULL,enabled boolean NOT NULL
);
CREATE TABLE happy_worker_sched_probe.organizations(organization_id uuid PRIMARY KEY,status text NOT NULL);
CREATE TABLE happy_worker_sched_probe.workspaces(organization_id uuid NOT NULL,workspace_id uuid NOT NULL,status text NOT NULL,PRIMARY KEY(organization_id,workspace_id));
CREATE TABLE happy_worker_sched_probe.organization_memberships(organization_id uuid NOT NULL,user_id uuid NOT NULL,status text NOT NULL,PRIMARY KEY(organization_id,user_id));
CREATE TABLE happy_worker_sched_probe.workspace_memberships(organization_id uuid NOT NULL,workspace_id uuid NOT NULL,user_id uuid NOT NULL,status text NOT NULL,PRIMARY KEY(organization_id,workspace_id,user_id));

INSERT INTO happy_worker_sched_probe.principal_registry VALUES
 ('00000000-0000-0000-0000-000000000010','postgres',ARRAY['CONTROL','VERIFY'],true,clock_timestamp(),null);
INSERT INTO happy_worker_sched_probe.tenant_grants VALUES
 ('00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',ARRAY['CONTROL','VERIFY'],true);
INSERT INTO happy_worker_sched_probe.organizations VALUES ('00000000-0000-0000-0000-000000000002','ACTIVE');
INSERT INTO happy_worker_sched_probe.workspaces VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','ACTIVE');
INSERT INTO happy_worker_sched_probe.organization_memberships VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000004','ACTIVE');
INSERT INTO happy_worker_sched_probe.workspace_memberships VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','ACTIVE');

DO $identity_rls$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['principal_registry','tenant_grants','organizations','workspaces','organization_memberships','workspace_memberships'] LOOP
  EXECUTE format('ALTER TABLE happy_worker_sched_probe.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY registry_select ON happy_worker_sched_probe.%I FOR SELECT TO happy_worker_registry_owner_probe USING (true)',t);
  EXECUTE format('CREATE POLICY registry_lock ON happy_worker_sched_probe.%I FOR UPDATE TO happy_worker_registry_owner_probe USING (true) WITH CHECK (false)',t);
 END LOOP;
END
$identity_rls$;

GRANT USAGE ON SCHEMA happy_worker_sched_probe TO happy_worker_registry_owner_probe;
GRANT SELECT(worker_principal_id,db_login_role,capabilities,enabled,activated_at,revoked_at)
 ON happy_worker_sched_probe.principal_registry TO happy_worker_registry_owner_probe;
GRANT UPDATE(enabled) ON happy_worker_sched_probe.principal_registry TO happy_worker_registry_owner_probe;
GRANT SELECT(worker_principal_id,organization_id,workspace_id,user_id,capabilities,enabled)
 ON happy_worker_sched_probe.tenant_grants TO happy_worker_registry_owner_probe;
GRANT UPDATE(enabled) ON happy_worker_sched_probe.tenant_grants TO happy_worker_registry_owner_probe;
GRANT SELECT(organization_id,status) ON happy_worker_sched_probe.organizations TO happy_worker_registry_owner_probe;
GRANT UPDATE(status) ON happy_worker_sched_probe.organizations TO happy_worker_registry_owner_probe;
GRANT SELECT(organization_id,workspace_id,status) ON happy_worker_sched_probe.workspaces TO happy_worker_registry_owner_probe;
GRANT UPDATE(status) ON happy_worker_sched_probe.workspaces TO happy_worker_registry_owner_probe;
GRANT SELECT(organization_id,user_id,status) ON happy_worker_sched_probe.organization_memberships TO happy_worker_registry_owner_probe;
GRANT UPDATE(status) ON happy_worker_sched_probe.organization_memberships TO happy_worker_registry_owner_probe;
GRANT SELECT(organization_id,workspace_id,user_id,status) ON happy_worker_sched_probe.workspace_memberships TO happy_worker_registry_owner_probe;
GRANT UPDATE(status) ON happy_worker_sched_probe.workspace_memberships TO happy_worker_registry_owner_probe;

CREATE FUNCTION happy_worker_sched_probe.require_principal(p_cap text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $principal$
DECLARE v_id uuid;
BEGIN
 SELECT worker_principal_id INTO v_id FROM happy_worker_sched_probe.principal_registry
 WHERE db_login_role=session_user AND enabled AND activated_at IS NOT NULL AND revoked_at IS NULL
 AND capabilities @> ARRAY[p_cap]::text[] FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'worker principal denied' USING ERRCODE='42501'; END IF;
 RETURN v_id;
END
$principal$;

CREATE FUNCTION happy_worker_sched_probe.require_scope(p_principal uuid,p_org uuid,p_workspace uuid,p_user uuid,p_cap text)
RETURNS uuid LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $scope$
DECLARE v_user uuid;
BEGIN
 IF happy_worker_sched_probe.require_principal(p_cap)<>p_principal THEN RAISE EXCEPTION 'principal mismatch' USING ERRCODE='42501'; END IF;
 SELECT user_id INTO v_user FROM happy_worker_sched_probe.tenant_grants
 WHERE worker_principal_id=p_principal AND organization_id=p_org AND workspace_id=p_workspace
 AND user_id=p_user AND enabled AND capabilities @> ARRAY[p_cap]::text[] FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'tenant grant denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM happy_worker_sched_probe.organizations WHERE organization_id=p_org AND status='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'org denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM happy_worker_sched_probe.workspaces WHERE organization_id=p_org AND workspace_id=p_workspace AND status='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'workspace denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM happy_worker_sched_probe.organization_memberships WHERE organization_id=p_org AND user_id=v_user AND status='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'org membership denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM happy_worker_sched_probe.workspace_memberships WHERE organization_id=p_org AND workspace_id=p_workspace AND user_id=v_user AND status='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'workspace membership denied' USING ERRCODE='42501'; END IF;
 RETURN v_user;
END
$scope$;

CREATE FUNCTION happy_worker_sched_probe.scope_policy(p_org uuid,p_workspace uuid,p_user uuid,p_cap text)
RETURNS boolean LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $policy$
DECLARE v_principal uuid;
BEGIN
 v_principal:=happy_worker_sched_probe.require_principal(p_cap);
 RETURN happy_worker_sched_probe.require_scope(v_principal,p_org,p_workspace,p_user,p_cap)=p_user;
EXCEPTION WHEN OTHERS THEN RETURN false;
END
$policy$;

ALTER FUNCTION happy_worker_sched_probe.require_principal(text) OWNER TO happy_worker_registry_owner_probe;
ALTER FUNCTION happy_worker_sched_probe.require_scope(uuid,uuid,uuid,uuid,text) OWNER TO happy_worker_registry_owner_probe;
ALTER FUNCTION happy_worker_sched_probe.scope_policy(uuid,uuid,uuid,text) OWNER TO happy_worker_registry_owner_probe;
REVOKE CREATE ON SCHEMA happy_worker_sched_probe FROM happy_worker_registry_owner_probe;

GRANT EXECUTE ON FUNCTION happy_worker_sched_probe.require_scope(uuid,uuid,uuid,uuid,text) TO happy_worker_scheduler_owner_probe;
GRANT EXECUTE ON FUNCTION happy_worker_sched_probe.scope_policy(uuid,uuid,uuid,text) TO happy_worker_scheduler_owner_probe;

CREATE TABLE happy_worker_sched_probe.tenant_records(
 organization_id uuid,workspace_id uuid,user_id uuid,entity_type text,record_id text,
 version bigint,data jsonb,updated_at timestamptz,
 PRIMARY KEY(organization_id,workspace_id,user_id,entity_type,record_id)
);
CREATE TABLE happy_worker_sched_probe.leases(
 organization_id uuid,workspace_id uuid,user_id uuid,mission_id text,task_id text,
 lease_id uuid,owner_id text,attempt int,fencing_token bigint,expires_at timestamptz,
 created_at timestamptz DEFAULT clock_timestamp(),updated_at timestamptz DEFAULT clock_timestamp(),
 PRIMARY KEY(organization_id,workspace_id,user_id,mission_id,task_id)
);
CREATE TABLE happy_worker_sched_probe.outbox(
 outbox_id uuid PRIMARY KEY,organization_id uuid,workspace_id uuid,user_id uuid,
 mission_id text,task_id text,lease_id uuid,fencing_token bigint,attempt int,
 execution_request_id text,idempotency_key text,capability text,action text,
 payload_digest text,payload jsonb,outcome jsonb NOT NULL DEFAULT '{}'::jsonb,status text NOT NULL DEFAULT 'PENDING',
 created_at timestamptz DEFAULT clock_timestamp(),updated_at timestamptz DEFAULT clock_timestamp()
);
CREATE TABLE happy_worker_sched_probe.requests(
 request_id text PRIMARY KEY,organization_id uuid,workspace_id uuid,requester_user_id uuid,executor_user_id uuid,
 mission_id text,task_id text,status text,approval_status text,requires_approval boolean,risk text,
 required_approval_role text,decided_by uuid,decided_at timestamptz
);
CREATE TABLE happy_worker_sched_probe.evidence(
 evidence_id uuid PRIMARY KEY,organization_id uuid,workspace_id uuid,user_id uuid,outbox_id uuid,
 idempotency_key text,provider_id text,observation_status text,observed_at timestamptz,observation jsonb
);

INSERT INTO happy_worker_sched_probe.tenant_records VALUES
 ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','MISSION','mission-1',1,'{"status":"READY","taskIds":["task-1"]}',clock_timestamp()),
 ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','TASK','task-1',1,'{"status":"READY","missionId":"mission-1"}',clock_timestamp());
INSERT INTO happy_worker_sched_probe.requests VALUES
 ('req-1','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','00000000-0000-0000-0000-000000000004','mission-1','task-1','READY','APPROVED',true,'HIGH','FOUNDER','00000000-0000-0000-0000-000000000005',clock_timestamp());

ALTER TABLE happy_worker_sched_probe.tenant_records ENABLE ROW LEVEL SECURITY;
ALTER TABLE happy_worker_sched_probe.leases ENABLE ROW LEVEL SECURITY;
ALTER TABLE happy_worker_sched_probe.outbox ENABLE ROW LEVEL SECURITY;
ALTER TABLE happy_worker_sched_probe.requests ENABLE ROW LEVEL SECURITY;
ALTER TABLE happy_worker_sched_probe.evidence ENABLE ROW LEVEL SECURITY;

GRANT SELECT ON happy_worker_sched_probe.tenant_records,happy_worker_sched_probe.leases,
 happy_worker_sched_probe.outbox,happy_worker_sched_probe.requests,happy_worker_sched_probe.evidence
 TO happy_worker_scheduler_owner_probe;
GRANT UPDATE(data,version,updated_at) ON happy_worker_sched_probe.tenant_records TO happy_worker_scheduler_owner_probe;
GRANT INSERT(organization_id,workspace_id,user_id,mission_id,task_id,lease_id,owner_id,attempt,fencing_token,expires_at)
 ON happy_worker_sched_probe.leases TO happy_worker_scheduler_owner_probe;
GRANT UPDATE(lease_id,owner_id,attempt,fencing_token,expires_at,updated_at)
 ON happy_worker_sched_probe.leases TO happy_worker_scheduler_owner_probe;
GRANT INSERT(outbox_id,organization_id,workspace_id,user_id,mission_id,task_id,lease_id,fencing_token,attempt,execution_request_id,idempotency_key,capability,action,payload_digest,payload)
 ON happy_worker_sched_probe.outbox TO happy_worker_scheduler_owner_probe;
GRANT UPDATE(status,outcome,updated_at) ON happy_worker_sched_probe.outbox TO happy_worker_scheduler_owner_probe;
GRANT UPDATE(status) ON happy_worker_sched_probe.requests TO happy_worker_scheduler_owner_probe;
GRANT INSERT(evidence_id,organization_id,workspace_id,user_id,outbox_id,idempotency_key,provider_id,observation_status,observed_at,observation)
 ON happy_worker_sched_probe.evidence TO happy_worker_scheduler_owner_probe;

CREATE POLICY tenant_control_select ON happy_worker_sched_probe.tenant_records FOR SELECT TO happy_worker_scheduler_owner_probe
 USING (entity_type IN ('MISSION','TASK') AND happy_worker_sched_probe.scope_policy(organization_id,workspace_id,user_id,'CONTROL'));
CREATE POLICY tenant_verify_select ON happy_worker_sched_probe.tenant_records FOR SELECT TO happy_worker_scheduler_owner_probe
 USING (entity_type IN ('MISSION','TASK') AND happy_worker_sched_probe.scope_policy(organization_id,workspace_id,user_id,'VERIFY'));
CREATE POLICY tenant_control_update ON happy_worker_sched_probe.tenant_records FOR UPDATE TO happy_worker_scheduler_owner_probe
 USING (entity_type IN ('MISSION','TASK') AND happy_worker_sched_probe.scope_policy(organization_id,workspace_id,user_id,'CONTROL'))
 WITH CHECK (entity_type IN ('MISSION','TASK') AND happy_worker_sched_probe.scope_policy(organization_id,workspace_id,user_id,'CONTROL'));

CREATE POLICY lease_select ON happy_worker_sched_probe.leases FOR SELECT TO happy_worker_scheduler_owner_probe
 USING (happy_worker_sched_probe.scope_policy(organization_id,workspace_id,user_id,'CONTROL'));
CREATE POLICY lease_insert ON happy_worker_sched_probe.leases FOR INSERT TO happy_worker_scheduler_owner_probe
 WITH CHECK (happy_worker_sched_probe.scope_policy(organization_id,workspace_id,user_id,'CONTROL'));
CREATE POLICY lease_update ON happy_worker_sched_probe.leases FOR UPDATE TO happy_worker_scheduler_owner_probe
 USING (happy_worker_sched_probe.scope_policy(organization_id,workspace_id,user_id,'CONTROL'))
 WITH CHECK (happy_worker_sched_probe.scope_policy(organization_id,workspace_id,user_id,'CONTROL'));

CREATE POLICY outbox_control_select ON happy_worker_sched_probe.outbox FOR SELECT TO happy_worker_scheduler_owner_probe
 USING (happy_worker_sched_probe.scope_policy(organization_id,workspace_id,user_id,'CONTROL'));
CREATE POLICY outbox_verify_select ON happy_worker_sched_probe.outbox FOR SELECT TO happy_worker_scheduler_owner_probe
 USING (happy_worker_sched_probe.scope_policy(organization_id,workspace_id,user_id,'VERIFY'));
CREATE POLICY outbox_insert ON happy_worker_sched_probe.outbox FOR INSERT TO happy_worker_scheduler_owner_probe
 WITH CHECK (happy_worker_sched_probe.scope_policy(organization_id,workspace_id,user_id,'CONTROL') AND status='PENDING');
CREATE POLICY outbox_control_update ON happy_worker_sched_probe.outbox FOR UPDATE TO happy_worker_scheduler_owner_probe
 USING (happy_worker_sched_probe.scope_policy(organization_id,workspace_id,user_id,'CONTROL') AND status IN ('PENDING','DISPATCHED'))
 WITH CHECK (happy_worker_sched_probe.scope_policy(organization_id,workspace_id,user_id,'CONTROL') AND status IN ('DISPATCHED','ACKNOWLEDGED','AMBIGUOUS','FAILED','RECONCILIATION_REQUIRED'));
CREATE POLICY outbox_verify_lock ON happy_worker_sched_probe.outbox FOR UPDATE TO happy_worker_scheduler_owner_probe
 USING (happy_worker_sched_probe.scope_policy(organization_id,workspace_id,user_id,'VERIFY') AND status='AMBIGUOUS')
 WITH CHECK (false);

CREATE POLICY request_select ON happy_worker_sched_probe.requests FOR SELECT TO happy_worker_scheduler_owner_probe
 USING (happy_worker_sched_probe.scope_policy(organization_id,workspace_id,executor_user_id,'CONTROL')
  AND requester_user_id=executor_user_id AND status IN ('READY','RUNNING')
  AND approval_status='APPROVED' AND requires_approval AND risk='HIGH'
  AND required_approval_role='FOUNDER' AND decided_by IS NOT NULL AND decided_by NOT IN (requester_user_id,executor_user_id) AND decided_at IS NOT NULL);
CREATE POLICY request_update ON happy_worker_sched_probe.requests FOR UPDATE TO happy_worker_scheduler_owner_probe
 USING (happy_worker_sched_probe.scope_policy(organization_id,workspace_id,executor_user_id,'CONTROL')
  AND requester_user_id=executor_user_id AND status IN ('READY','RUNNING') AND approval_status='APPROVED')
 WITH CHECK (happy_worker_sched_probe.scope_policy(organization_id,workspace_id,executor_user_id,'CONTROL')
  AND requester_user_id=executor_user_id AND status IN ('RUNNING','FAILED','BLOCKED') AND approval_status='APPROVED');

CREATE POLICY evidence_select ON happy_worker_sched_probe.evidence FOR SELECT TO happy_worker_scheduler_owner_probe
 USING (happy_worker_sched_probe.scope_policy(organization_id,workspace_id,user_id,'VERIFY'));
CREATE POLICY evidence_insert ON happy_worker_sched_probe.evidence FOR INSERT TO happy_worker_scheduler_owner_probe
 WITH CHECK (happy_worker_sched_probe.scope_policy(organization_id,workspace_id,user_id,'VERIFY')
  AND EXISTS(SELECT 1 FROM happy_worker_sched_probe.outbox o
   WHERE o.outbox_id=evidence.outbox_id AND o.organization_id=evidence.organization_id
    AND o.workspace_id=evidence.workspace_id AND o.user_id=evidence.user_id
    AND o.status='AMBIGUOUS' AND o.idempotency_key=evidence.idempotency_key
    AND o.outcome->>'provider'=evidence.provider_id));

CREATE FUNCTION happy_worker_sched_probe.control_cycle()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $control$
DECLARE actor uuid; task jsonb; task_version bigint; req happy_worker_sched_probe.requests%rowtype;
BEGIN
 actor:=happy_worker_sched_probe.require_scope('00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','CONTROL');
 SELECT data,version INTO task,task_version FROM happy_worker_sched_probe.tenant_records
  WHERE organization_id='00000000-0000-0000-0000-000000000002' AND workspace_id='00000000-0000-0000-0000-000000000003'
   AND user_id=actor AND entity_type='TASK' AND record_id='task-1' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'task lock failed'; END IF;
 UPDATE happy_worker_sched_probe.tenant_records SET data=jsonb_set(data,'{status}','"RUNNING"'),version=version+1,updated_at=clock_timestamp()
  WHERE organization_id='00000000-0000-0000-0000-000000000002' AND workspace_id='00000000-0000-0000-0000-000000000003'
   AND user_id=actor AND entity_type='TASK' AND record_id='task-1' AND version=task_version;
 IF NOT FOUND THEN RAISE EXCEPTION 'task update failed'; END IF;

 INSERT INTO happy_worker_sched_probe.leases(
  organization_id,workspace_id,user_id,mission_id,task_id,lease_id,owner_id,attempt,fencing_token,expires_at
 ) VALUES (
  '00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',actor,'mission-1','task-1',
  '00000000-0000-0000-0000-000000000020','worker-owner',1,1,clock_timestamp()+interval '1 minute'
 );

 SELECT * INTO req FROM happy_worker_sched_probe.requests WHERE request_id='req-1' FOR UPDATE;
 IF NOT FOUND THEN RAISE EXCEPTION 'request lock failed'; END IF;
 UPDATE happy_worker_sched_probe.requests SET status='RUNNING' WHERE request_id='req-1' AND status='READY';
 IF NOT FOUND THEN RAISE EXCEPTION 'request update failed'; END IF;

 INSERT INTO happy_worker_sched_probe.outbox(
  outbox_id,organization_id,workspace_id,user_id,mission_id,task_id,lease_id,fencing_token,attempt,
  execution_request_id,idempotency_key,capability,action,payload_digest,payload
 ) VALUES (
  '00000000-0000-0000-0000-000000000030','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',actor,
  'mission-1','task-1','00000000-0000-0000-0000-000000000020',1,1,'req-1','idem-1','CODE','execute','sha256:'||repeat('a',64),
  '{"id":"req-1"}'::jsonb
 );

 UPDATE happy_worker_sched_probe.outbox SET status='DISPATCHED',updated_at=clock_timestamp()
  WHERE outbox_id='00000000-0000-0000-0000-000000000030' AND status='PENDING';
 IF NOT FOUND THEN RAISE EXCEPTION 'outbox dispatch update failed'; END IF;
 UPDATE happy_worker_sched_probe.outbox SET status='AMBIGUOUS',outcome='{"provider":"provider-x"}'::jsonb,updated_at=clock_timestamp()
  WHERE outbox_id='00000000-0000-0000-0000-000000000030' AND status='DISPATCHED';
 IF NOT FOUND THEN RAISE EXCEPTION 'outbox ambiguous update failed'; END IF;
 UPDATE happy_worker_sched_probe.requests SET status='BLOCKED' WHERE request_id='req-1' AND status='RUNNING';
 IF NOT FOUND THEN RAISE EXCEPTION 'request blocked update failed'; END IF;
 RETURN true;
END
$control$;

CREATE FUNCTION happy_worker_sched_probe.verify_cycle()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $verify$
DECLARE actor uuid; outbox_row happy_worker_sched_probe.outbox%rowtype; affected int;
BEGIN
 actor:=happy_worker_sched_probe.require_scope('00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','VERIFY');
 SELECT * INTO outbox_row FROM happy_worker_sched_probe.outbox
  WHERE outbox_id='00000000-0000-0000-0000-000000000030' AND status='AMBIGUOUS' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'VERIFY worker could not lock ambiguous outbox'; END IF;
 BEGIN
  UPDATE happy_worker_sched_probe.outbox SET status='ACKNOWLEDGED' WHERE outbox_id=outbox_row.outbox_id;
  GET DIAGNOSTICS affected=ROW_COUNT;
  RAISE EXCEPTION 'VERIFY worker unexpectedly mutated outbox; rows=%',affected;
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 INSERT INTO happy_worker_sched_probe.evidence VALUES
  ('00000000-0000-0000-0000-000000000040','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003',actor,
   outbox_row.outbox_id,'idem-1','provider-x','UNKNOWN',clock_timestamp(),'{"status":"UNKNOWN"}'::jsonb);
 PERFORM 1 FROM happy_worker_sched_probe.evidence WHERE outbox_id=outbox_row.outbox_id;
 IF NOT FOUND THEN RAISE EXCEPTION 'VERIFY evidence read failed'; END IF;
 RETURN true;
END
$verify$;

ALTER FUNCTION happy_worker_sched_probe.control_cycle() OWNER TO happy_worker_scheduler_owner_probe;
ALTER FUNCTION happy_worker_sched_probe.verify_cycle() OWNER TO happy_worker_scheduler_owner_probe;
REVOKE CREATE ON SCHEMA happy_worker_sched_probe FROM happy_worker_scheduler_owner_probe;
REVOKE ALL ON FUNCTION happy_worker_sched_probe.control_cycle() FROM PUBLIC;
REVOKE ALL ON FUNCTION happy_worker_sched_probe.verify_cycle() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION happy_worker_sched_probe.control_cycle() TO authenticated;
GRANT EXECUTE ON FUNCTION happy_worker_sched_probe.verify_cycle() TO authenticated;

SET LOCAL ROLE authenticated;
DO $test$
BEGIN
 IF happy_worker_sched_probe.control_cycle() IS DISTINCT FROM true THEN RAISE EXCEPTION 'CONTROL worker lifecycle failed'; END IF;
 IF happy_worker_sched_probe.verify_cycle() IS DISTINCT FROM true THEN RAISE EXCEPTION 'VERIFY worker evidence lifecycle failed'; END IF;
END
$test$;
RESET ROLE;

DO $assert$
DECLARE attrs record; api_memberships bigint;
BEGIN
 SELECT rolcanlogin,rolsuper,rolcreaterole,rolcreatedb,rolreplication,rolbypassrls,rolinherit INTO attrs
 FROM pg_catalog.pg_roles WHERE rolname='happy_worker_scheduler_owner_probe';
 IF attrs.rolcanlogin OR attrs.rolsuper OR attrs.rolcreaterole OR attrs.rolcreatedb OR attrs.rolreplication OR attrs.rolbypassrls OR attrs.rolinherit THEN
  RAISE EXCEPTION 'scheduler owner role attributes unsafe';
 END IF;
 SELECT count(*) INTO api_memberships FROM pg_catalog.pg_auth_members m
 JOIN pg_catalog.pg_roles granted ON granted.oid=m.roleid
 JOIN pg_catalog.pg_roles member ON member.oid=m.member
 WHERE granted.rolname='happy_worker_scheduler_owner_probe'
 AND member.rolname IN ('anon','authenticated','service_role','authenticator');
 IF api_memberships<>0 THEN RAISE EXCEPTION 'API role member of scheduler owner'; END IF;
END
$assert$;

ROLLBACK;
