-- Disposable Supabase PostgreSQL 17 function-owner / RLS probe.
-- Run only on an isolated Supabase test project as its database administrator.
-- All roles, schemas, tables, functions, grants and membership changes roll back.
-- The trusted postgres admin is temporarily made a member solely to transfer
-- function ownership; no API role or worker login is made a member of the owner.
BEGIN;

CREATE ROLE happy_owner_probe
  NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;

-- Supabase's hosted postgres role is not SUPERUSER. Membership is needed to
-- transfer function ownership and is contained entirely in this transaction.
GRANT happy_owner_probe TO postgres;

CREATE SCHEMA happy_owner_probe;
CREATE TABLE happy_owner_probe.records (
  id bigint PRIMARY KEY,
  tenant_id text NOT NULL,
  lock_marker boolean NOT NULL DEFAULT false
);
INSERT INTO happy_owner_probe.records (id, tenant_id) VALUES (1, 'tenant-a');

ALTER TABLE happy_owner_probe.records ENABLE ROW LEVEL SECURITY;
CREATE POLICY happy_owner_probe_select
  ON happy_owner_probe.records
  FOR SELECT TO happy_owner_probe
  USING (tenant_id = 'tenant-a');

GRANT USAGE, CREATE ON SCHEMA happy_owner_probe TO happy_owner_probe;
GRANT USAGE ON SCHEMA happy_owner_probe TO authenticated;
GRANT SELECT ON happy_owner_probe.records TO happy_owner_probe;
GRANT UPDATE (lock_marker) ON happy_owner_probe.records TO happy_owner_probe;

CREATE FUNCTION happy_owner_probe.lock_and_check()
RETURNS boolean
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog
AS $function$
DECLARE
  affected bigint;
BEGIN
  -- UPDATE privilege is required for FOR SHARE, but an UPDATE RLS policy is not.
  PERFORM id
    FROM happy_owner_probe.records
   WHERE id = 1
   FOR SHARE;

  -- No UPDATE policy exists; RLS must filter this to zero rows.
  UPDATE happy_owner_probe.records
     SET lock_marker = true
   WHERE id = 1;
  GET DIAGNOSTICS affected = ROW_COUNT;

  IF affected <> 0 THEN
    RAISE EXCEPTION 'FAIL: owner mutated a row without an UPDATE RLS policy';
  END IF;
  RETURN true;
END
$function$;

ALTER FUNCTION happy_owner_probe.lock_and_check() OWNER TO happy_owner_probe;
REVOKE CREATE ON SCHEMA happy_owner_probe FROM happy_owner_probe;
REVOKE ALL ON FUNCTION happy_owner_probe.lock_and_check() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION happy_owner_probe.lock_and_check() TO authenticated;

-- The API caller executes the function, but is not a member of the owner role.
SET LOCAL ROLE authenticated;
DO $execute$
BEGIN
  IF happy_owner_probe.lock_and_check() IS DISTINCT FROM true THEN
    RAISE EXCEPTION 'FAIL: SECURITY DEFINER owner function did not pass';
  END IF;
END
$execute$;
RESET ROLE;

DO $assert$
DECLARE
  v_role record;
  v_api_memberships bigint;
  v_marker boolean;
  v_owner oid;
  v_security_definer boolean;
  v_search_path text[];
BEGIN
  SELECT rolcanlogin, rolsuper, rolcreaterole, rolcreatedb,
         rolreplication, rolbypassrls, rolinherit
    INTO v_role
    FROM pg_catalog.pg_roles
   WHERE rolname = 'happy_owner_probe';

  IF v_role.rolcanlogin OR v_role.rolsuper OR v_role.rolcreaterole
     OR v_role.rolcreatedb OR v_role.rolreplication
     OR v_role.rolbypassrls OR v_role.rolinherit THEN
    RAISE EXCEPTION 'FAIL: function owner has unsafe role attributes';
  END IF;

  SELECT count(*)
    INTO v_api_memberships
    FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles granted ON granted.oid = m.roleid
    JOIN pg_catalog.pg_roles member ON member.oid = m.member
   WHERE granted.rolname = 'happy_owner_probe'
     AND member.rolname IN ('anon', 'authenticated', 'service_role', 'authenticator');

  IF v_api_memberships <> 0 THEN
    RAISE EXCEPTION 'FAIL: API role is a member of the function owner';
  END IF;

  SELECT p.proowner, p.prosecdef, p.proconfig
    INTO v_owner, v_security_definer, v_search_path
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid = p.pronamespace
   WHERE n.nspname = 'happy_owner_probe'
     AND p.proname = 'lock_and_check';

  IF v_owner <> (SELECT oid FROM pg_catalog.pg_roles WHERE rolname = 'happy_owner_probe')
     OR v_security_definer IS DISTINCT FROM true
     OR NOT ('search_path=pg_catalog' = ANY(v_search_path)) THEN
    RAISE EXCEPTION 'FAIL: function owner, SECURITY DEFINER or search_path mismatch';
  END IF;

  SELECT lock_marker INTO v_marker
    FROM happy_owner_probe.records
   WHERE id = 1;

  IF v_marker IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL: UPDATE RLS policy failed to block mutation';
  END IF;
END
$assert$;

ROLLBACK;
