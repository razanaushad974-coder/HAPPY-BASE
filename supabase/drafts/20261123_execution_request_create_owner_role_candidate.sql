-- DESIGN-ONLY role provisioning candidate for authenticated execution request creation and resolution.
-- This role owns SECURITY DEFINER RPCs but never bypasses RLS.
-- DO NOT APPLY until the matching privilege candidate and tests are reviewed.
BEGIN;
DO $role$
DECLARE v_role pg_catalog.pg_roles%rowtype;
BEGIN
  SELECT * INTO v_role FROM pg_catalog.pg_roles WHERE rolname='happy_execution_request_create_rpc_owner';
  IF NOT FOUND THEN
    CREATE ROLE happy_execution_request_create_rpc_owner
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  ELSIF v_role.rolcanlogin OR v_role.rolsuper OR v_role.rolcreaterole
     OR v_role.rolcreatedb OR v_role.rolreplication
     OR v_role.rolbypassrls OR v_role.rolinherit THEN
    RAISE EXCEPTION 'Existing happy_execution_request_create_rpc_owner has unsafe attributes';
  END IF;
END
$role$;

-- Trusted database administrator membership is used only for ALTER FUNCTION
-- OWNER transfer. Never grant this owner role to API or worker LOGIN roles.
GRANT happy_execution_request_create_rpc_owner TO postgres;
COMMIT;
