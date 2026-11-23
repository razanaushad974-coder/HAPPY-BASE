-- HAPPY worker registry self-read helper grant candidate.
-- Apply only after the dedicated happy_worker_* LOGIN roles and their
-- operator-approved registry rows exist. This does NOT grant scheduler RPCs,
-- table access, tenant grants, or execution capabilities.
--
-- This grants only the session_user-derived helper, which returns the active
-- registry row for the current PostgreSQL LOGIN role and rejects disabled,
-- unactivated, revoked, or invalid roles. Never grant this function to
-- PUBLIC, anon, authenticated, or service_role.

do $worker_registry_helper_grants$
declare
  v_login_role text;
begin
  for v_login_role in
    select distinct p.db_login_role
      from private.happy_worker_principal_registry p
      join pg_catalog.pg_roles r
        on r.rolname = p.db_login_role
     where r.rolcanlogin = true
       and r.rolsuper = false
       and r.rolcreaterole = false
       and r.rolcreatedb = false
       and r.rolreplication = false
       and r.rolbypassrls = false
  loop
    execute format('grant usage on schema private to %I', v_login_role);
    execute format(
      'grant execute on function private.happy_require_worker_principal(text) to %I',
      v_login_role
    );
  end loop;
end;
$worker_registry_helper_grants$;

-- Operator verification after applying this candidate:
-- 1. As the dedicated worker LOGIN role, the helper returns exactly one row
--    for CONTROL only when that role is currently registered and active.
-- 2. The same role cannot SELECT either private worker registry table.
-- 3. authenticated, anon, and service_role cannot execute the helper.
-- 4. No worker-facing scheduler RPC is granted by this script.
