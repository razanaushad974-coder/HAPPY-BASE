-- DESIGN-ONLY role provisioning candidate.
-- Apply before the async tenant persistence schema candidate, because its
-- function-owner RLS policies must target this role.
-- DO NOT APPLY until the canonical identity baseline is reviewed.
BEGIN;
DO $role$
DECLARE v_role pg_catalog.pg_roles%rowtype;
BEGIN
  SELECT * INTO v_role FROM pg_catalog.pg_roles WHERE rolname='happy_tenant_scope_rpc_owner';
  IF NOT FOUND THEN
    CREATE ROLE happy_tenant_scope_rpc_owner
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE
      NOREPLICATION NOBYPASSRLS;
  ELSIF v_role.rolcanlogin OR v_role.rolsuper OR v_role.rolcreaterole
     OR v_role.rolcreatedb OR v_role.rolreplication
     OR v_role.rolbypassrls OR v_role.rolinherit THEN
    RAISE EXCEPTION 'Existing happy_tenant_scope_rpc_owner has unsafe attributes';
  END IF;
END
$role$;

-- Trusted database administrator membership is only for function ownership
-- transfer. Never grant this owner role to API roles or worker LOGIN roles.
GRANT happy_tenant_scope_rpc_owner TO postgres;
COMMIT;
