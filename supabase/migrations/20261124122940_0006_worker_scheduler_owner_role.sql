-- DESIGN-ONLY role provisioning candidate for worker scheduler SECURITY DEFINER RPCs.
-- This role is distinct from the registry owner and never bypasses RLS.
-- DO NOT APPLY until worker scheduler grant/policy candidates are reviewed.
BEGIN;
DO $role$
DECLARE v_role pg_catalog.pg_roles%rowtype;
BEGIN
 SELECT * INTO v_role FROM pg_catalog.pg_roles WHERE rolname='happy_worker_scheduler_rpc_owner';
 IF NOT FOUND THEN
  CREATE ROLE happy_worker_scheduler_rpc_owner
   NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
 ELSIF v_role.rolcanlogin OR v_role.rolsuper OR v_role.rolcreaterole OR v_role.rolcreatedb
    OR v_role.rolreplication OR v_role.rolbypassrls OR v_role.rolinherit THEN
  RAISE EXCEPTION 'Existing happy_worker_scheduler_rpc_owner has unsafe attributes';
 END IF;
END
$role$;
GRANT happy_worker_scheduler_rpc_owner TO postgres;
COMMIT;
