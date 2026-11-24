-- Disposable VERIFY-only worker outbox lock/RLS probe.
-- Supabase PostgreSQL 17.12; session_user=postgres is a synthetic registered
-- worker only inside this rollback transaction, not a production identity test.
BEGIN;
CREATE ROLE happy_worker_registry_verify_probe NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
CREATE ROLE happy_worker_scheduler_verify_probe NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
GRANT happy_worker_registry_verify_probe TO postgres;
GRANT happy_worker_scheduler_verify_probe TO postgres;
CREATE SCHEMA happy_worker_verify_probe;
GRANT USAGE,CREATE ON SCHEMA happy_worker_verify_probe TO happy_worker_registry_verify_probe,happy_worker_scheduler_verify_probe;
GRANT USAGE ON SCHEMA happy_worker_verify_probe TO authenticated;

CREATE TABLE happy_worker_verify_probe.principal_registry(worker_principal_id uuid PRIMARY KEY,db_login_role text,capabilities text[],enabled boolean,activated_at timestamptz,revoked_at timestamptz);
CREATE TABLE happy_worker_verify_probe.tenant_grants(worker_principal_id uuid,organization_id uuid,workspace_id uuid,user_id uuid,capabilities text[],enabled boolean);
CREATE TABLE happy_worker_verify_probe.organizations(organization_id uuid PRIMARY KEY,status text);
CREATE TABLE happy_worker_verify_probe.workspaces(organization_id uuid,workspace_id uuid,status text,PRIMARY KEY(organization_id,workspace_id));
CREATE TABLE happy_worker_verify_probe.organization_memberships(organization_id uuid,user_id uuid,status text,PRIMARY KEY(organization_id,user_id));
CREATE TABLE happy_worker_verify_probe.workspace_memberships(organization_id uuid,workspace_id uuid,user_id uuid,status text,PRIMARY KEY(organization_id,workspace_id,user_id));
INSERT INTO happy_worker_verify_probe.principal_registry VALUES('00000000-0000-0000-0000-000000000010','postgres',ARRAY['VERIFY'],true,clock_timestamp(),null);
INSERT INTO happy_worker_verify_probe.tenant_grants VALUES('00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',ARRAY['VERIFY'],true);
INSERT INTO happy_worker_verify_probe.organizations VALUES('00000000-0000-0000-0000-000000000002','ACTIVE');
INSERT INTO happy_worker_verify_probe.workspaces VALUES('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','ACTIVE');
INSERT INTO happy_worker_verify_probe.organization_memberships VALUES('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000004','ACTIVE');
INSERT INTO happy_worker_verify_probe.workspace_memberships VALUES('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','ACTIVE');

DO $rls$
DECLARE t text;
BEGIN
 FOREACH t IN ARRAY ARRAY['principal_registry','tenant_grants','organizations','workspaces','organization_memberships','workspace_memberships'] LOOP
  EXECUTE format('ALTER TABLE happy_worker_verify_probe.%I ENABLE ROW LEVEL SECURITY',t);
  EXECUTE format('CREATE POLICY registry_select ON happy_worker_verify_probe.%I FOR SELECT TO happy_worker_registry_verify_probe USING (true)',t);
  EXECUTE format('CREATE POLICY registry_lock ON happy_worker_verify_probe.%I FOR UPDATE TO happy_worker_registry_verify_probe USING (true) WITH CHECK (false)',t);
 END LOOP;
END
$rls$;
GRANT SELECT(worker_principal_id,db_login_role,capabilities,enabled,activated_at,revoked_at) ON happy_worker_verify_probe.principal_registry TO happy_worker_registry_verify_probe;
GRANT UPDATE(enabled) ON happy_worker_verify_probe.principal_registry TO happy_worker_registry_verify_probe;
GRANT SELECT(worker_principal_id,organization_id,workspace_id,user_id,capabilities,enabled) ON happy_worker_verify_probe.tenant_grants TO happy_worker_registry_verify_probe;
GRANT UPDATE(enabled) ON happy_worker_verify_probe.tenant_grants TO happy_worker_registry_verify_probe;
GRANT SELECT(organization_id,status) ON happy_worker_verify_probe.organizations TO happy_worker_registry_verify_probe;
GRANT UPDATE(status) ON happy_worker_verify_probe.organizations TO happy_worker_registry_verify_probe;
GRANT SELECT(organization_id,workspace_id,status) ON happy_worker_verify_probe.workspaces TO happy_worker_registry_verify_probe;
GRANT UPDATE(status) ON happy_worker_verify_probe.workspaces TO happy_worker_registry_verify_probe;
GRANT SELECT(organization_id,user_id,status) ON happy_worker_verify_probe.organization_memberships TO happy_worker_registry_verify_probe;
GRANT UPDATE(status) ON happy_worker_verify_probe.organization_memberships TO happy_worker_registry_verify_probe;
GRANT SELECT(organization_id,workspace_id,user_id,status) ON happy_worker_verify_probe.workspace_memberships TO happy_worker_registry_verify_probe;
GRANT UPDATE(status) ON happy_worker_verify_probe.workspace_memberships TO happy_worker_registry_verify_probe;

CREATE FUNCTION happy_worker_verify_probe.require_principal(p_cap text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE v uuid;
BEGIN
 SELECT worker_principal_id INTO v FROM happy_worker_verify_probe.principal_registry
 WHERE db_login_role=session_user AND enabled AND activated_at IS NOT NULL AND revoked_at IS NULL
 AND capabilities @> ARRAY[p_cap]::text[] FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'principal denied' USING ERRCODE='42501'; END IF;
 RETURN v;
END $fn$;
CREATE FUNCTION happy_worker_verify_probe.require_scope(p_id uuid,p_org uuid,p_ws uuid,p_user uuid,p_cap text) RETURNS uuid
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE v uuid;
BEGIN
 IF happy_worker_verify_probe.require_principal(p_cap)<>p_id THEN RAISE EXCEPTION 'principal mismatch' USING ERRCODE='42501'; END IF;
 SELECT user_id INTO v FROM happy_worker_verify_probe.tenant_grants
 WHERE worker_principal_id=p_id AND organization_id=p_org AND workspace_id=p_ws AND user_id=p_user
 AND enabled AND capabilities @> ARRAY[p_cap]::text[] FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'tenant grant denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM happy_worker_verify_probe.organizations WHERE organization_id=p_org AND status='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'org denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM happy_worker_verify_probe.workspaces WHERE organization_id=p_org AND workspace_id=p_ws AND status='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'workspace denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM happy_worker_verify_probe.organization_memberships WHERE organization_id=p_org AND user_id=v AND status='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'org member denied' USING ERRCODE='42501'; END IF;
 PERFORM 1 FROM happy_worker_verify_probe.workspace_memberships WHERE organization_id=p_org AND workspace_id=p_ws AND user_id=v AND status='ACTIVE' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'workspace member denied' USING ERRCODE='42501'; END IF;
 RETURN v;
END $fn$;
CREATE FUNCTION happy_worker_verify_probe.scope_policy(p_org uuid,p_ws uuid,p_user uuid,p_cap text) RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog AS $fn$
DECLARE v_id uuid;
BEGIN
 v_id:=happy_worker_verify_probe.require_principal(p_cap);
 RETURN happy_worker_verify_probe.require_scope(v_id,p_org,p_ws,p_user,p_cap)=p_user;
EXCEPTION WHEN OTHERS THEN RETURN false;
END $fn$;
ALTER FUNCTION happy_worker_verify_probe.require_principal(text) OWNER TO happy_worker_registry_verify_probe;
ALTER FUNCTION happy_worker_verify_probe.require_scope(uuid,uuid,uuid,uuid,text) OWNER TO happy_worker_registry_verify_probe;
ALTER FUNCTION happy_worker_verify_probe.scope_policy(uuid,uuid,uuid,text) OWNER TO happy_worker_registry_verify_probe;
REVOKE CREATE ON SCHEMA happy_worker_verify_probe FROM happy_worker_registry_verify_probe;
GRANT EXECUTE ON FUNCTION happy_worker_verify_probe.require_scope(uuid,uuid,uuid,uuid,text) TO happy_worker_scheduler_verify_probe;
GRANT EXECUTE ON FUNCTION happy_worker_verify_probe.scope_policy(uuid,uuid,uuid,text) TO happy_worker_scheduler_verify_probe;

CREATE TABLE happy_worker_verify_probe.outbox(outbox_id uuid PRIMARY KEY,organization_id uuid,workspace_id uuid,user_id uuid,idempotency_key text,status text,outcome jsonb);
INSERT INTO happy_worker_verify_probe.outbox VALUES('00000000-0000-0000-0000-000000000030','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','idem-1','AMBIGUOUS','{"provider":"provider-x"}');
ALTER TABLE happy_worker_verify_probe.outbox ENABLE ROW LEVEL SECURITY;
GRANT SELECT ON happy_worker_verify_probe.outbox TO happy_worker_scheduler_verify_probe;
GRANT UPDATE(status,outcome) ON happy_worker_verify_probe.outbox TO happy_worker_scheduler_verify_probe;
CREATE POLICY outbox_verify_select ON happy_worker_verify_probe.outbox FOR SELECT TO happy_worker_scheduler_verify_probe
 USING(happy_worker_verify_probe.scope_policy(organization_id,workspace_id,user_id,'VERIFY'));
CREATE POLICY outbox_control_update ON happy_worker_verify_probe.outbox FOR UPDATE TO happy_worker_scheduler_verify_probe
 USING(happy_worker_verify_probe.scope_policy(organization_id,workspace_id,user_id,'CONTROL') AND status IN ('PENDING','DISPATCHED'))
 WITH CHECK(happy_worker_verify_probe.scope_policy(organization_id,workspace_id,user_id,'CONTROL') AND status IN ('DISPATCHED','ACKNOWLEDGED','AMBIGUOUS','FAILED','RECONCILIATION_REQUIRED'));
CREATE POLICY outbox_verify_lock ON happy_worker_verify_probe.outbox FOR UPDATE TO happy_worker_scheduler_verify_probe
 USING(happy_worker_verify_probe.scope_policy(organization_id,workspace_id,user_id,'VERIFY') AND status='AMBIGUOUS')
 WITH CHECK(false);

CREATE FUNCTION happy_worker_verify_probe.verify_lock()
RETURNS boolean LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $fn$
DECLARE actor uuid; row_value happy_worker_verify_probe.outbox%rowtype;
BEGIN
 actor:=happy_worker_verify_probe.require_scope('00000000-0000-0000-0000-000000000010','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','VERIFY');
 SELECT * INTO row_value FROM happy_worker_verify_probe.outbox WHERE status='AMBIGUOUS' FOR SHARE;
 IF NOT FOUND THEN RAISE EXCEPTION 'VERIFY lock returned no row'; END IF;
 BEGIN
  UPDATE happy_worker_verify_probe.outbox SET status='ACKNOWLEDGED' WHERE outbox_id=row_value.outbox_id;
  RAISE EXCEPTION 'VERIFY unexpectedly mutated outbox';
 EXCEPTION WHEN insufficient_privilege THEN NULL;
 END;
 RETURN true;
END $fn$;
ALTER FUNCTION happy_worker_verify_probe.verify_lock() OWNER TO happy_worker_scheduler_verify_probe;
REVOKE CREATE ON SCHEMA happy_worker_verify_probe FROM happy_worker_scheduler_verify_probe;
REVOKE ALL ON FUNCTION happy_worker_verify_probe.verify_lock() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION happy_worker_verify_probe.verify_lock() TO authenticated;

SET LOCAL ROLE authenticated;
DO $test$
BEGIN
 IF happy_worker_verify_probe.verify_lock() IS DISTINCT FROM true THEN RAISE EXCEPTION 'VERIFY lock-only policy failed'; END IF;
END
$test$;
RESET ROLE;
ROLLBACK;
