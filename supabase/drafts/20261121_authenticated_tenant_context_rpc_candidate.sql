-- DESIGN-ONLY authenticated tenant-context RPC.
-- Replaces the superseded BYPASSRLS design note with the current
-- NOLOGIN/NOBYPASSRLS least-privilege owner model.
-- Ordered after migration 0009, which provisions the tenant-scope owner,
-- grants only required SELECT columns, and installs scoped RLS policies.
-- This RPC is read-only: it does not provision tenants, mutate memberships,
-- or persist a selected tenant. Tenant IDs are selectors, never authority.
-- DO NOT apply to a connected/shared/production Supabase project.

BEGIN;

GRANT CREATE ON SCHEMA public TO happy_tenant_scope_rpc_owner;
GRANT SELECT (role)
  ON private.organization_memberships TO happy_tenant_scope_rpc_owner;
GRANT SELECT (role)
  ON private.workspace_memberships TO happy_tenant_scope_rpc_owner;

CREATE OR REPLACE FUNCTION public.resolve_authenticated_tenant_context(
  p_organization_id uuid,
  p_workspace_id uuid
)
RETURNS TABLE (
  user_id uuid,
  organization_id uuid,
  workspace_id uuid,
  organization_role text,
  workspace_role text
)
LANGUAGE plpgsql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
SET row_security = on
AS $function$
DECLARE
  v_user_id uuid;
BEGIN
  v_user_id := private.happy_current_authenticated_user_id();

  IF v_user_id IS NULL
     OR p_organization_id IS NULL
     OR p_workspace_id IS NULL THEN
    RETURN;
  END IF;

  RETURN QUERY
  SELECT
    v_user_id,
    o.organization_id,
    w.workspace_id,
    om.role,
    wm.role
  FROM private.organizations AS o
  JOIN private.workspaces AS w
    ON w.organization_id = o.organization_id
   AND w.workspace_id = p_workspace_id
  JOIN private.organization_memberships AS om
    ON om.organization_id = o.organization_id
   AND om.user_id = v_user_id
   AND om.status = 'ACTIVE'
  JOIN private.workspace_memberships AS wm
    ON wm.organization_id = w.organization_id
   AND wm.workspace_id = w.workspace_id
   AND wm.user_id = v_user_id
   AND wm.status = 'ACTIVE'
  WHERE o.organization_id = p_organization_id
    AND o.status = 'ACTIVE'
    AND w.status = 'ACTIVE'
    AND length(btrim(om.role)) > 0
    AND length(btrim(wm.role)) > 0;
END;
$function$;

ALTER FUNCTION public.resolve_authenticated_tenant_context(uuid, uuid)
  OWNER TO happy_tenant_scope_rpc_owner;

REVOKE CREATE ON SCHEMA public FROM happy_tenant_scope_rpc_owner;

REVOKE ALL ON FUNCTION public.resolve_authenticated_tenant_context(uuid, uuid)
  FROM PUBLIC, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION public.resolve_authenticated_tenant_context(uuid, uuid)
  TO authenticated;

COMMENT ON FUNCTION public.resolve_authenticated_tenant_context(uuid, uuid) IS
  'Read-only tenant selector verification. Principal derives from the request JWT through a private auth.uid() accessor; tenant IDs are selectors, not authority.';

DO $assert$
DECLARE
  v_owner text;
  v_config text[];
  v_security_definer boolean;
BEGIN
  SELECT
    pg_catalog.pg_get_userbyid(p.proowner),
    p.proconfig,
    p.prosecdef
  INTO v_owner, v_config, v_security_definer
  FROM pg_catalog.pg_proc AS p
  WHERE p.oid = 'public.resolve_authenticated_tenant_context(uuid,uuid)'::regprocedure;

  IF v_owner IS DISTINCT FROM 'happy_tenant_scope_rpc_owner'
     OR NOT coalesce(v_security_definer, false)
     OR NOT ('search_path=pg_catalog' = ANY(coalesce(v_config, ARRAY[]::text[])))
     OR NOT ('row_security=on' = ANY(coalesce(v_config, ARRAY[]::text[]))) THEN
    RAISE EXCEPTION 'Tenant-context RPC owner/security configuration mismatch';
  END IF;

  IF NOT has_function_privilege('authenticated',
       'public.resolve_authenticated_tenant_context(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Authenticated role is missing tenant-context RPC EXECUTE';
  END IF;
  IF has_function_privilege('anon',
       'public.resolve_authenticated_tenant_context(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Anonymous role unexpectedly has tenant-context RPC EXECUTE';
  END IF;
  IF has_function_privilege('service_role',
       'public.resolve_authenticated_tenant_context(uuid,uuid)', 'EXECUTE') THEN
    RAISE EXCEPTION 'Service role unexpectedly has tenant-context RPC EXECUTE';
  END IF;
  IF NOT has_function_privilege('happy_tenant_scope_rpc_owner',
       'private.happy_current_authenticated_user_id()', 'EXECUTE') THEN
    RAISE EXCEPTION 'Tenant-context owner is missing the private JWT subject accessor';
  END IF;
  IF NOT has_column_privilege('happy_tenant_scope_rpc_owner',
       'private.organization_memberships', 'organization_id', 'SELECT')
     OR NOT has_column_privilege('happy_tenant_scope_rpc_owner',
       'private.organization_memberships', 'user_id', 'SELECT')
     OR NOT has_column_privilege('happy_tenant_scope_rpc_owner',
       'private.organization_memberships', 'status', 'SELECT')
     OR NOT has_column_privilege('happy_tenant_scope_rpc_owner',
       'private.organization_memberships', 'role', 'SELECT')
     OR NOT has_column_privilege('happy_tenant_scope_rpc_owner',
       'private.workspace_memberships', 'organization_id', 'SELECT')
     OR NOT has_column_privilege('happy_tenant_scope_rpc_owner',
       'private.workspace_memberships', 'workspace_id', 'SELECT')
     OR NOT has_column_privilege('happy_tenant_scope_rpc_owner',
       'private.workspace_memberships', 'user_id', 'SELECT')
     OR NOT has_column_privilege('happy_tenant_scope_rpc_owner',
       'private.workspace_memberships', 'status', 'SELECT')
     OR NOT has_column_privilege('happy_tenant_scope_rpc_owner',
       'private.workspace_memberships', 'role', 'SELECT') THEN
    RAISE EXCEPTION 'Tenant-context owner lacks exact membership SELECT columns';
  END IF;

  IF (SELECT rolcanlogin OR rolsuper OR rolbypassrls OR rolinherit
      FROM pg_catalog.pg_roles
      WHERE rolname = 'happy_tenant_scope_rpc_owner') THEN
    RAISE EXCEPTION 'Tenant-context RPC owner has unsafe role attributes';
  END IF;
END
$assert$;

COMMIT;
