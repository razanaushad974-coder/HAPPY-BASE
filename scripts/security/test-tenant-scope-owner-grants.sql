-- Disposable tenant-scope RPC owner / tenant-record RLS probe.
-- Supabase PostgreSQL 17.12; run only on isolated staging as postgres.
-- Models the tenant-scope candidate's private identity and public record access.
-- All roles, schemas, tables, functions, policies, grants and writes roll back.
BEGIN;

CREATE ROLE happy_tenant_scope_rpc_owner
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
GRANT happy_tenant_scope_rpc_owner TO postgres;

CREATE SCHEMA happy_tenant_probe;
GRANT USAGE, CREATE ON SCHEMA happy_tenant_probe TO happy_tenant_scope_rpc_owner;
GRANT USAGE ON SCHEMA happy_tenant_probe TO authenticated;
GRANT USAGE ON SCHEMA auth TO happy_tenant_scope_rpc_owner;
GRANT EXECUTE ON FUNCTION auth.uid() TO happy_tenant_scope_rpc_owner;

CREATE TABLE happy_tenant_probe.organizations (
  organization_id uuid PRIMARY KEY,
  status text NOT NULL
);
CREATE TABLE happy_tenant_probe.workspaces (
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  status text NOT NULL,
  PRIMARY KEY (organization_id, workspace_id)
);
CREATE TABLE happy_tenant_probe.organization_memberships (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);
CREATE TABLE happy_tenant_probe.workspace_memberships (
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL,
  PRIMARY KEY (organization_id, workspace_id, user_id)
);
CREATE TABLE happy_tenant_probe.tenant_records (
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  entity_type text NOT NULL,
  record_id text NOT NULL,
  version bigint NOT NULL DEFAULT 1,
  data jsonb NOT NULL,
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  updated_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,workspace_id,user_id,entity_type,record_id)
);

INSERT INTO happy_tenant_probe.organizations VALUES
('00000000-0000-0000-0000-000000000002','ACTIVE');
INSERT INTO happy_tenant_probe.workspaces VALUES
('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','ACTIVE');
INSERT INTO happy_tenant_probe.organization_memberships VALUES
('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000004','ACTIVE');
INSERT INTO happy_tenant_probe.workspace_memberships VALUES
('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','ACTIVE');

DO $rls_identity$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organizations','workspaces','organization_memberships','workspace_memberships'
  ] LOOP
    EXECUTE format('ALTER TABLE happy_tenant_probe.%I ENABLE ROW LEVEL SECURITY',t);
    EXECUTE format(
      'CREATE POLICY owner_select ON happy_tenant_probe.%I FOR SELECT TO happy_tenant_scope_rpc_owner USING (true)',t
    );
    EXECUTE format(
      'CREATE POLICY owner_lock_only ON happy_tenant_probe.%I FOR UPDATE TO happy_tenant_scope_rpc_owner USING (true) WITH CHECK (false)',t
    );
  END LOOP;
END
$rls_identity$;

ALTER TABLE happy_tenant_probe.tenant_records ENABLE ROW LEVEL SECURITY;

GRANT SELECT (organization_id,status)
  ON happy_tenant_probe.organizations TO happy_tenant_scope_rpc_owner;
GRANT UPDATE (status)
  ON happy_tenant_probe.organizations TO happy_tenant_scope_rpc_owner;
GRANT SELECT (organization_id,workspace_id,status)
  ON happy_tenant_probe.workspaces TO happy_tenant_scope_rpc_owner;
GRANT UPDATE (status)
  ON happy_tenant_probe.workspaces TO happy_tenant_scope_rpc_owner;
GRANT SELECT (organization_id,user_id,status)
  ON happy_tenant_probe.organization_memberships TO happy_tenant_scope_rpc_owner;
GRANT UPDATE (status)
  ON happy_tenant_probe.organization_memberships TO happy_tenant_scope_rpc_owner;
GRANT SELECT (organization_id,workspace_id,user_id,status)
  ON happy_tenant_probe.workspace_memberships TO happy_tenant_scope_rpc_owner;
GRANT UPDATE (status)
  ON happy_tenant_probe.workspace_memberships TO happy_tenant_scope_rpc_owner;

GRANT SELECT ON happy_tenant_probe.tenant_records TO happy_tenant_scope_rpc_owner;
GRANT INSERT (organization_id,workspace_id,user_id,entity_type,record_id,version,data)
  ON happy_tenant_probe.tenant_records TO happy_tenant_scope_rpc_owner;
GRANT UPDATE (data,version,updated_at)
  ON happy_tenant_probe.tenant_records TO happy_tenant_scope_rpc_owner;
GRANT DELETE ON happy_tenant_probe.tenant_records TO happy_tenant_scope_rpc_owner;

CREATE FUNCTION happy_tenant_probe.has_active_scope(p_org uuid,p_workspace uuid)
RETURNS boolean
LANGUAGE sql STABLE SECURITY DEFINER SET search_path=pg_catalog
AS $scope$
  SELECT EXISTS (
    SELECT 1
      FROM happy_tenant_probe.organizations o
      JOIN happy_tenant_probe.workspaces w
        ON w.organization_id=o.organization_id
      JOIN happy_tenant_probe.organization_memberships om
        ON om.organization_id=o.organization_id
      JOIN happy_tenant_probe.workspace_memberships wm
        ON wm.organization_id=w.organization_id
       AND wm.workspace_id=w.workspace_id
       AND wm.user_id=om.user_id
     WHERE o.organization_id=p_org
       AND w.workspace_id=p_workspace
       AND om.user_id=auth.uid()
       AND o.status='ACTIVE' AND w.status='ACTIVE'
       AND om.status='ACTIVE' AND wm.status='ACTIVE'
  );
$scope$;

CREATE FUNCTION happy_tenant_probe.lock_active_scope(p_org uuid,p_workspace uuid)
RETURNS boolean
LANGUAGE plpgsql VOLATILE SECURITY DEFINER SET search_path=pg_catalog
AS $lock$
DECLARE actor uuid;
BEGIN
  actor:=auth.uid();
  IF actor IS NULL THEN RETURN false; END IF;

  PERFORM 1 FROM happy_tenant_probe.organizations
   WHERE organization_id=p_org AND status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM happy_tenant_probe.workspaces
   WHERE organization_id=p_org AND workspace_id=p_workspace AND status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM happy_tenant_probe.organization_memberships
   WHERE organization_id=p_org AND user_id=actor AND status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  PERFORM 1 FROM happy_tenant_probe.workspace_memberships
   WHERE organization_id=p_org AND workspace_id=p_workspace
     AND user_id=actor AND status='ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RETURN false; END IF;
  RETURN true;
END
$lock$;

CREATE POLICY tenant_owner_select ON happy_tenant_probe.tenant_records
  FOR SELECT TO happy_tenant_scope_rpc_owner
  USING (user_id=auth.uid() AND happy_tenant_probe.has_active_scope(organization_id,workspace_id));
CREATE POLICY tenant_owner_insert ON happy_tenant_probe.tenant_records
  FOR INSERT TO happy_tenant_scope_rpc_owner
  WITH CHECK (user_id=auth.uid() AND version=1 AND happy_tenant_probe.has_active_scope(organization_id,workspace_id));
CREATE POLICY tenant_owner_update ON happy_tenant_probe.tenant_records
  FOR UPDATE TO happy_tenant_scope_rpc_owner
  USING (user_id=auth.uid() AND happy_tenant_probe.has_active_scope(organization_id,workspace_id))
  WITH CHECK (user_id=auth.uid() AND happy_tenant_probe.has_active_scope(organization_id,workspace_id));
CREATE POLICY tenant_owner_delete ON happy_tenant_probe.tenant_records
  FOR DELETE TO happy_tenant_scope_rpc_owner
  USING (user_id=auth.uid() AND happy_tenant_probe.has_active_scope(organization_id,workspace_id));

CREATE FUNCTION happy_tenant_probe.create_record(p_org uuid,p_workspace uuid,p_type text,p_id text,p_data jsonb)
RETURNS happy_tenant_probe.tenant_records
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $create$
DECLARE actor uuid; result happy_tenant_probe.tenant_records%rowtype;
BEGIN
  actor:=auth.uid();
  IF actor IS NULL OR NOT happy_tenant_probe.lock_active_scope(p_org,p_workspace) THEN
    RAISE EXCEPTION 'TENANT_SCOPE_DENIED' USING ERRCODE='42501';
  END IF;
  INSERT INTO happy_tenant_probe.tenant_records
    (organization_id,workspace_id,user_id,entity_type,record_id,version,data)
  VALUES (p_org,p_workspace,actor,p_type,p_id,1,p_data)
  RETURNING * INTO result;
  RETURN result;
END
$create$;

CREATE FUNCTION happy_tenant_probe.update_record(p_org uuid,p_workspace uuid,p_type text,p_id text,p_expected bigint,p_data jsonb)
RETURNS happy_tenant_probe.tenant_records
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $update$
DECLARE actor uuid; result happy_tenant_probe.tenant_records%rowtype; exists_row boolean;
BEGIN
  actor:=auth.uid();
  IF actor IS NULL OR NOT happy_tenant_probe.lock_active_scope(p_org,p_workspace) THEN
    RAISE EXCEPTION 'TENANT_SCOPE_DENIED' USING ERRCODE='42501';
  END IF;
  UPDATE happy_tenant_probe.tenant_records r
     SET data=p_data,version=r.version+1,updated_at=clock_timestamp()
   WHERE r.organization_id=p_org AND r.workspace_id=p_workspace
     AND r.user_id=actor AND r.entity_type=p_type AND r.record_id=p_id
     AND r.version=p_expected
  RETURNING r.* INTO result;
  IF FOUND THEN RETURN result; END IF;
  SELECT EXISTS(SELECT 1 FROM happy_tenant_probe.tenant_records r
    WHERE r.organization_id=p_org AND r.workspace_id=p_workspace
      AND r.user_id=actor AND r.entity_type=p_type AND r.record_id=p_id)
    INTO exists_row;
  IF exists_row THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  RAISE EXCEPTION 'RECORD_NOT_FOUND' USING ERRCODE='P0002';
END
$update$;

CREATE FUNCTION happy_tenant_probe.delete_record(p_org uuid,p_workspace uuid,p_type text,p_id text,p_expected bigint)
RETURNS boolean
LANGUAGE plpgsql SECURITY DEFINER SET search_path=pg_catalog
AS $delete$
DECLARE actor uuid; exists_row boolean;
BEGIN
  actor:=auth.uid();
  IF actor IS NULL OR NOT happy_tenant_probe.lock_active_scope(p_org,p_workspace) THEN
    RAISE EXCEPTION 'TENANT_SCOPE_DENIED' USING ERRCODE='42501';
  END IF;
  DELETE FROM happy_tenant_probe.tenant_records r
   WHERE r.organization_id=p_org AND r.workspace_id=p_workspace
     AND r.user_id=actor AND r.entity_type=p_type AND r.record_id=p_id
     AND r.version=p_expected;
  IF FOUND THEN RETURN true; END IF;
  SELECT EXISTS(SELECT 1 FROM happy_tenant_probe.tenant_records r
    WHERE r.organization_id=p_org AND r.workspace_id=p_workspace
      AND r.user_id=actor AND r.entity_type=p_type AND r.record_id=p_id)
    INTO exists_row;
  IF exists_row THEN RAISE EXCEPTION 'VERSION_CONFLICT' USING ERRCODE='40001'; END IF;
  RETURN false;
END
$delete$;

ALTER FUNCTION happy_tenant_probe.has_active_scope(uuid,uuid) OWNER TO happy_tenant_scope_rpc_owner;
ALTER FUNCTION happy_tenant_probe.lock_active_scope(uuid,uuid) OWNER TO happy_tenant_scope_rpc_owner;
ALTER FUNCTION happy_tenant_probe.create_record(uuid,uuid,text,text,jsonb) OWNER TO happy_tenant_scope_rpc_owner;
ALTER FUNCTION happy_tenant_probe.update_record(uuid,uuid,text,text,bigint,jsonb) OWNER TO happy_tenant_scope_rpc_owner;
ALTER FUNCTION happy_tenant_probe.delete_record(uuid,uuid,text,text,bigint) OWNER TO happy_tenant_scope_rpc_owner;
REVOKE CREATE ON SCHEMA happy_tenant_probe FROM happy_tenant_scope_rpc_owner;

REVOKE ALL ON FUNCTION happy_tenant_probe.create_record(uuid,uuid,text,text,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION happy_tenant_probe.update_record(uuid,uuid,text,text,bigint,jsonb) FROM PUBLIC;
REVOKE ALL ON FUNCTION happy_tenant_probe.delete_record(uuid,uuid,text,text,bigint) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION happy_tenant_probe.create_record(uuid,uuid,text,text,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION happy_tenant_probe.update_record(uuid,uuid,text,text,bigint,jsonb) TO authenticated;
GRANT EXECUTE ON FUNCTION happy_tenant_probe.delete_record(uuid,uuid,text,text,bigint) TO authenticated;

-- User identity is supplied only through the JWT subject setting, as auth.uid() reads it.
SELECT set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004',true);
SET LOCAL ROLE authenticated;

DO $test$
DECLARE created happy_tenant_probe.tenant_records%rowtype;
        updated happy_tenant_probe.tenant_records%rowtype;
        denied boolean:=false;
BEGIN
  SELECT * INTO created FROM happy_tenant_probe.create_record(
    '00000000-0000-0000-0000-000000000002',
    '00000000-0000-0000-0000-000000000003',
    'MISSION','mission-1','{"status":"READY"}'::jsonb
  );
  IF created.version<>1 OR created.user_id<>auth.uid() THEN
    RAISE EXCEPTION 'create path failed';
  END IF;

  SELECT * INTO updated FROM happy_tenant_probe.update_record(
    created.organization_id,created.workspace_id,created.entity_type,created.record_id,1,
    '{"status":"RUNNING"}'::jsonb
  );
  IF updated.version<>2 OR updated.data->>'status'<>'RUNNING' THEN
    RAISE EXCEPTION 'CAS update path failed';
  END IF;

  BEGIN
    PERFORM happy_tenant_probe.update_record(
      created.organization_id,created.workspace_id,created.entity_type,created.record_id,1,
      '{"status":"STALE"}'::jsonb
    );
  EXCEPTION WHEN serialization_failure THEN
    denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'stale CAS was not rejected'; END IF;

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000005',true);
  denied:=false;
  BEGIN
    PERFORM happy_tenant_probe.update_record(
      created.organization_id,created.workspace_id,created.entity_type,created.record_id,2,
      '{"status":"CROSS_USER"}'::jsonb
    );
  EXCEPTION WHEN insufficient_privilege THEN
    denied:=true;
  END;
  IF NOT denied THEN RAISE EXCEPTION 'cross-user update was not denied'; END IF;

  PERFORM set_config('request.jwt.claim.sub','00000000-0000-0000-0000-000000000004',true);
  IF happy_tenant_probe.delete_record(
    created.organization_id,created.workspace_id,created.entity_type,created.record_id,2
  ) IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'CAS delete path failed';
  END IF;
END
$test$;
RESET ROLE;

ROLLBACK;
