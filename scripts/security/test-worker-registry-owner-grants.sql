-- Disposable worker-registry owner privilege matrix probe.
-- Supabase PostgreSQL 17.12; run only on isolated test project as postgres.
-- Uses the six table shapes and exact read/lock columns from the current draft.
-- All roles, schemas, tables, functions, policies and grants roll back.
BEGIN;

CREATE ROLE happy_worker_registry_owner
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
  NOREPLICATION NOBYPASSRLS;
GRANT happy_worker_registry_owner TO postgres;

CREATE SCHEMA happy_registry_probe;
GRANT USAGE, CREATE ON SCHEMA happy_registry_probe TO happy_worker_registry_owner;
GRANT USAGE ON SCHEMA happy_registry_probe TO authenticated;

CREATE TABLE happy_registry_probe.principal_registry (
  worker_principal_id uuid PRIMARY KEY,
  db_login_role text NOT NULL,
  issuer text NOT NULL,
  subject text NOT NULL,
  audience text NOT NULL,
  environment text NOT NULL,
  capabilities text[] NOT NULL,
  enabled boolean NOT NULL,
  activated_at timestamptz,
  revoked_at timestamptz
);
CREATE TABLE happy_registry_probe.tenant_grants (
  worker_principal_id uuid NOT NULL,
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  capabilities text[] NOT NULL,
  enabled boolean NOT NULL
);
CREATE TABLE happy_registry_probe.organizations (
  organization_id uuid PRIMARY KEY,
  status text NOT NULL
);
CREATE TABLE happy_registry_probe.workspaces (
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  status text NOT NULL,
  PRIMARY KEY (organization_id, workspace_id)
);
CREATE TABLE happy_registry_probe.organization_memberships (
  organization_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL,
  PRIMARY KEY (organization_id, user_id)
);
CREATE TABLE happy_registry_probe.workspace_memberships (
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL,
  status text NOT NULL,
  PRIMARY KEY (organization_id, workspace_id, user_id)
);

INSERT INTO happy_registry_probe.principal_registry VALUES
('00000000-0000-0000-0000-000000000001','happy_worker_probe','issuer','subject','audience','staging',ARRAY['CONTROL'],true,clock_timestamp(),null);
INSERT INTO happy_registry_probe.tenant_grants VALUES
('00000000-0000-0000-0000-000000000001','00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004',ARRAY['CONTROL'],true);
INSERT INTO happy_registry_probe.organizations VALUES ('00000000-0000-0000-0000-000000000002','ACTIVE');
INSERT INTO happy_registry_probe.workspaces VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','ACTIVE');
INSERT INTO happy_registry_probe.organization_memberships VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000004','ACTIVE');
INSERT INTO happy_registry_probe.workspace_memberships VALUES ('00000000-0000-0000-0000-000000000002','00000000-0000-0000-0000-000000000003','00000000-0000-0000-0000-000000000004','ACTIVE');

DO $rls$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'principal_registry','tenant_grants','organizations','workspaces',
    'organization_memberships','workspace_memberships'
  ] LOOP
    EXECUTE format('ALTER TABLE happy_registry_probe.%I ENABLE ROW LEVEL SECURITY', t);
    EXECUTE format(
      'CREATE POLICY owner_select ON happy_registry_probe.%I FOR SELECT TO happy_worker_registry_owner USING (true)',
      t
    );
  END LOOP;
END
$rls$;

GRANT SELECT (
  worker_principal_id, db_login_role, issuer, subject, audience,
  environment, capabilities, enabled, activated_at, revoked_at
) ON happy_registry_probe.principal_registry TO happy_worker_registry_owner;
GRANT UPDATE (enabled)
  ON happy_registry_probe.principal_registry TO happy_worker_registry_owner;

GRANT SELECT (
  worker_principal_id, organization_id, workspace_id, user_id, capabilities, enabled
) ON happy_registry_probe.tenant_grants TO happy_worker_registry_owner;
GRANT UPDATE (enabled)
  ON happy_registry_probe.tenant_grants TO happy_worker_registry_owner;

GRANT SELECT (organization_id, status)
  ON happy_registry_probe.organizations TO happy_worker_registry_owner;
GRANT UPDATE (status)
  ON happy_registry_probe.organizations TO happy_worker_registry_owner;

GRANT SELECT (organization_id, workspace_id, status)
  ON happy_registry_probe.workspaces TO happy_worker_registry_owner;
GRANT UPDATE (status)
  ON happy_registry_probe.workspaces TO happy_worker_registry_owner;

GRANT SELECT (organization_id, user_id, status)
  ON happy_registry_probe.organization_memberships TO happy_worker_registry_owner;
GRANT UPDATE (status)
  ON happy_registry_probe.organization_memberships TO happy_worker_registry_owner;

GRANT SELECT (organization_id, workspace_id, user_id, status)
  ON happy_registry_probe.workspace_memberships TO happy_worker_registry_owner;
GRANT UPDATE (status)
  ON happy_registry_probe.workspace_memberships TO happy_worker_registry_owner;

CREATE FUNCTION happy_registry_probe.lock_all_scope_rows()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  n bigint;
BEGIN
  PERFORM worker_principal_id FROM happy_registry_probe.principal_registry
   WHERE db_login_role = 'happy_worker_probe' AND enabled
     AND activated_at IS NOT NULL AND revoked_at IS NULL
     AND capabilities @> ARRAY['CONTROL']::text[] FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'registry lock failed'; END IF;

  PERFORM user_id FROM happy_registry_probe.tenant_grants
   WHERE worker_principal_id = '00000000-0000-0000-0000-000000000001'
     AND organization_id = '00000000-0000-0000-0000-000000000002'
     AND workspace_id = '00000000-0000-0000-0000-000000000003'
     AND user_id = '00000000-0000-0000-0000-000000000004'
     AND enabled AND capabilities @> ARRAY['CONTROL']::text[] FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'tenant grant lock failed'; END IF;

  PERFORM organization_id FROM happy_registry_probe.organizations
   WHERE organization_id = '00000000-0000-0000-0000-000000000002'
     AND status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization lock failed'; END IF;

  PERFORM workspace_id FROM happy_registry_probe.workspaces
   WHERE organization_id = '00000000-0000-0000-0000-000000000002'
     AND workspace_id = '00000000-0000-0000-0000-000000000003'
     AND status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace lock failed'; END IF;

  PERFORM user_id FROM happy_registry_probe.organization_memberships
   WHERE organization_id = '00000000-0000-0000-0000-000000000002'
     AND user_id = '00000000-0000-0000-0000-000000000004'
     AND status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'organization membership lock failed'; END IF;

  PERFORM user_id FROM happy_registry_probe.workspace_memberships
   WHERE organization_id = '00000000-0000-0000-0000-000000000002'
     AND workspace_id = '00000000-0000-0000-0000-000000000003'
     AND user_id = '00000000-0000-0000-0000-000000000004'
     AND status = 'ACTIVE' FOR SHARE;
  IF NOT FOUND THEN RAISE EXCEPTION 'workspace membership lock failed'; END IF;

  UPDATE happy_registry_probe.principal_registry SET enabled = false;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'registry UPDATE escaped RLS'; END IF;
  UPDATE happy_registry_probe.tenant_grants SET enabled = false;
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'tenant grant UPDATE escaped RLS'; END IF;
  UPDATE happy_registry_probe.organizations SET status = 'REVOKED';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'organization UPDATE escaped RLS'; END IF;
  UPDATE happy_registry_probe.workspaces SET status = 'REVOKED';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'workspace UPDATE escaped RLS'; END IF;
  UPDATE happy_registry_probe.organization_memberships SET status = 'REVOKED';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'organization membership UPDATE escaped RLS'; END IF;
  UPDATE happy_registry_probe.workspace_memberships SET status = 'REVOKED';
  GET DIAGNOSTICS n = ROW_COUNT;
  IF n <> 0 THEN RAISE EXCEPTION 'workspace membership UPDATE escaped RLS'; END IF;

  RETURN true;
END
$function$;

ALTER FUNCTION happy_registry_probe.lock_all_scope_rows() OWNER TO happy_worker_registry_owner;
REVOKE CREATE ON SCHEMA happy_registry_probe FROM happy_worker_registry_owner;
REVOKE ALL ON FUNCTION happy_registry_probe.lock_all_scope_rows() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION happy_registry_probe.lock_all_scope_rows() TO authenticated;

SET LOCAL ROLE authenticated;
DO $call$
BEGIN
  IF happy_registry_probe.lock_all_scope_rows() IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'worker registry owner grant matrix failed';
  END IF;
END
$call$;
RESET ROLE;

DO $assert$
DECLARE
  unsafe boolean;
  api_memberships bigint;
  update_policies bigint;
BEGIN
  SELECT rolcanlogin OR rolsuper OR rolcreaterole OR rolcreatedb
      OR rolreplication OR rolbypassrls OR rolinherit
    INTO unsafe
    FROM pg_catalog.pg_roles
   WHERE rolname = 'happy_worker_registry_owner';
  IF unsafe IS DISTINCT FROM false THEN RAISE EXCEPTION 'unsafe owner attributes'; END IF;

  SELECT count(*) INTO api_memberships
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = m.member
   WHERE granted.rolname = 'happy_worker_registry_owner'
     AND member.rolname IN ('anon','authenticated','service_role','authenticator');
  IF api_memberships <> 0 THEN RAISE EXCEPTION 'API role is owner member'; END IF;

  SELECT count(*) INTO update_policies
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'happy_registry_probe'
     AND cmd = 'UPDATE'
     AND ('public' = ANY(roles) OR 'happy_worker_registry_owner' = ANY(roles));
  IF update_policies <> 0 THEN RAISE EXCEPTION 'unexpected UPDATE RLS policy'; END IF;
END
$assert$;

ROLLBACK;
