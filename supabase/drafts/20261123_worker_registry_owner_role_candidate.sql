-- DESIGN-ONLY role provisioning candidate.
-- Apply order: before 20261122_worker_principal_registry_candidate.sql.
-- DO NOT APPLY until the full tenant baseline and migration executor are reviewed.
BEGIN;

DO $role$
DECLARE
  v_role pg_catalog.pg_roles%rowtype;
BEGIN
  SELECT * INTO v_role
    FROM pg_catalog.pg_roles
   WHERE rolname = 'happy_worker_registry_owner';

  IF NOT FOUND THEN
    CREATE ROLE happy_worker_registry_owner
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  ELSIF v_role.rolcanlogin
     OR v_role.rolsuper
     OR v_role.rolcreaterole
     OR v_role.rolcreatedb
     OR v_role.rolreplication
     OR v_role.rolbypassrls
     OR v_role.rolinherit THEN
    RAISE EXCEPTION 'Existing happy_worker_registry_owner has unsafe attributes';
  END IF;
END
$role$;

-- Supabase hosted postgres is not SUPERUSER. This trusted administrative
-- membership permits ALTER FUNCTION ... OWNER TO; do not grant membership
-- to authenticated, anon, service_role, authenticator, or worker LOGIN roles.
GRANT happy_worker_registry_owner TO postgres;

COMMIT;
