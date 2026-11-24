-- DESIGN-ONLY bootstrap for the JWT subject accessor required by the
-- async tenant-persistence schema's SECURITY DEFINER tenant-scope predicate.
-- This is split from the full tenant-scope owner privilege candidate because
-- the latter also references public.happy_tenant_records and its RPC functions,
-- which are created only by the later async tenant-persistence migration.
-- DO NOT APPLY to a connected/shared/production Supabase project.
BEGIN;

GRANT USAGE ON SCHEMA private, public TO happy_tenant_scope_rpc_owner;

-- Keep auth.uid() behind a tiny, non-exposed SECURITY DEFINER accessor owned
-- by postgres. It returns only the JWT subject exposed by Supabase auth.uid()
-- and performs no table access; EXECUTE is limited to explicitly reviewed
-- NOLOGIN function-owner roles (never API or worker LOGIN roles).
CREATE OR REPLACE FUNCTION private.happy_current_authenticated_user_id()
RETURNS uuid
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog
AS $current_user$
  SELECT auth.uid();
$current_user$;

ALTER FUNCTION private.happy_current_authenticated_user_id() OWNER TO postgres;

DO $accessor_check$
DECLARE v_owner text; v_config text[];
BEGIN
  SELECT pg_catalog.pg_get_userbyid(p.proowner), p.proconfig
    INTO v_owner, v_config
    FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
   WHERE n.nspname='private'
     AND p.proname='happy_current_authenticated_user_id';
  IF NOT FOUND
     OR v_owner IS DISTINCT FROM 'postgres'
     OR NOT ('search_path=pg_catalog' = ANY(coalesce(v_config, ARRAY[]::text[])))
     OR NOT coalesce((SELECT p.prosecdef FROM pg_catalog.pg_proc p
                       JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
                      WHERE n.nspname='private'
                        AND p.proname='happy_current_authenticated_user_id'), false) THEN
    RAISE EXCEPTION 'JWT subject accessor owner/security/search_path mismatch';
  END IF;
END
$accessor_check$;

REVOKE ALL ON FUNCTION private.happy_current_authenticated_user_id()
  FROM public, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.happy_current_authenticated_user_id()
  TO happy_tenant_scope_rpc_owner;

COMMIT;
