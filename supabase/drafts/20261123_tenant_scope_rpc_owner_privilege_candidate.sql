-- DESIGN-ONLY least-privilege tenant-scope RPC owner grants.
-- Prerequisites:
--   * canonical private organization/workspace/membership tables exist;
--   * public.happy_tenant_records and all five RPC functions exist;
--   * happy_tenant_scope_rpc_owner is provisioned;
--   * auth.uid() behavior is verified with real JWT claims.
-- DO NOT APPLY to a connected/shared/production project.
BEGIN;

GRANT USAGE ON SCHEMA private, public, auth TO happy_tenant_scope_rpc_owner;
GRANT EXECUTE ON FUNCTION auth.uid() TO happy_tenant_scope_rpc_owner;

-- Private canonical identity lookups. The SELECT policies admit rows to the
-- NOLOGIN owner; the lock-only UPDATE policies allow FOR SHARE but reject
-- every attempted mutation through WITH CHECK (false).
DO $policies$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY[
    'organizations','workspaces','organization_memberships','workspace_memberships'
  ] LOOP
    EXECUTE format(
      'DROP POLICY IF EXISTS happy_tenant_scope_rpc_owner_select ON private.%I', t
    );
    EXECUTE format(
      'CREATE POLICY happy_tenant_scope_rpc_owner_select ON private.%I FOR SELECT TO happy_tenant_scope_rpc_owner USING (true)', t
    );
    EXECUTE format(
      'DROP POLICY IF EXISTS happy_tenant_scope_rpc_owner_lock ON private.%I', t
    );
    EXECUTE format(
      'CREATE POLICY happy_tenant_scope_rpc_owner_lock ON private.%I FOR UPDATE TO happy_tenant_scope_rpc_owner USING (true) WITH CHECK (false)', t
    );
  END LOOP;
END
$policies$;

GRANT SELECT (organization_id, status)
  ON private.organizations TO happy_tenant_scope_rpc_owner;
GRANT UPDATE (status)
  ON private.organizations TO happy_tenant_scope_rpc_owner;

GRANT SELECT (organization_id, workspace_id, status)
  ON private.workspaces TO happy_tenant_scope_rpc_owner;
GRANT UPDATE (status)
  ON private.workspaces TO happy_tenant_scope_rpc_owner;

GRANT SELECT (organization_id, user_id, status)
  ON private.organization_memberships TO happy_tenant_scope_rpc_owner;
GRANT UPDATE (status)
  ON private.organization_memberships TO happy_tenant_scope_rpc_owner;

GRANT SELECT (organization_id, workspace_id, user_id, status)
  ON private.workspace_memberships TO happy_tenant_scope_rpc_owner;
GRANT UPDATE (status)
  ON private.workspace_memberships TO happy_tenant_scope_rpc_owner;

-- RLS for the tenant record table remains caller-bound even inside SECURITY
-- DEFINER functions. auth.uid() is the JWT subject; tenant IDs are selectors.
DROP POLICY IF EXISTS happy_tenant_records_scope_owner_select ON public.happy_tenant_records;
CREATE POLICY happy_tenant_records_scope_owner_select
  ON public.happy_tenant_records
  FOR SELECT TO happy_tenant_scope_rpc_owner
  USING (
    user_id = auth.uid()
    AND public.happy_has_active_tenant_scope(organization_id, workspace_id)
  );

DROP POLICY IF EXISTS happy_tenant_records_scope_owner_insert ON public.happy_tenant_records;
CREATE POLICY happy_tenant_records_scope_owner_insert
  ON public.happy_tenant_records
  FOR INSERT TO happy_tenant_scope_rpc_owner
  WITH CHECK (
    user_id = auth.uid()
    AND version = 1
    AND public.happy_has_active_tenant_scope(organization_id, workspace_id)
  );

DROP POLICY IF EXISTS happy_tenant_records_scope_owner_update ON public.happy_tenant_records;
CREATE POLICY happy_tenant_records_scope_owner_update
  ON public.happy_tenant_records
  FOR UPDATE TO happy_tenant_scope_rpc_owner
  USING (
    user_id = auth.uid()
    AND public.happy_has_active_tenant_scope(organization_id, workspace_id)
  )
  WITH CHECK (
    user_id = auth.uid()
    AND public.happy_has_active_tenant_scope(organization_id, workspace_id)
  );

DROP POLICY IF EXISTS happy_tenant_records_scope_owner_delete ON public.happy_tenant_records;
CREATE POLICY happy_tenant_records_scope_owner_delete
  ON public.happy_tenant_records
  FOR DELETE TO happy_tenant_scope_rpc_owner
  USING (
    user_id = auth.uid()
    AND public.happy_has_active_tenant_scope(organization_id, workspace_id)
  );

GRANT SELECT ON public.happy_tenant_records TO happy_tenant_scope_rpc_owner;
GRANT INSERT (
  organization_id, workspace_id, user_id, entity_type, record_id, version, data
) ON public.happy_tenant_records TO happy_tenant_scope_rpc_owner;
GRANT UPDATE (data, version, updated_at)
  ON public.happy_tenant_records TO happy_tenant_scope_rpc_owner;
GRANT DELETE ON public.happy_tenant_records TO happy_tenant_scope_rpc_owner;

-- Temporarily grant CREATE for owner reassignment, then remove it.
GRANT CREATE ON SCHEMA private, public TO happy_tenant_scope_rpc_owner;

ALTER FUNCTION public.happy_has_active_tenant_scope(uuid,uuid)
  OWNER TO happy_tenant_scope_rpc_owner;
ALTER FUNCTION public.happy_lock_active_tenant_scope(uuid,uuid)
  OWNER TO happy_tenant_scope_rpc_owner;
ALTER FUNCTION public.happy_create_tenant_record(uuid,uuid,text,text,jsonb)
  OWNER TO happy_tenant_scope_rpc_owner;
ALTER FUNCTION public.happy_update_tenant_record(uuid,uuid,text,text,bigint,jsonb)
  OWNER TO happy_tenant_scope_rpc_owner;
ALTER FUNCTION public.happy_delete_tenant_record(uuid,uuid,text,text,bigint)
  OWNER TO happy_tenant_scope_rpc_owner;

REVOKE CREATE ON SCHEMA private, public FROM happy_tenant_scope_rpc_owner;

-- No API-role direct access to the private lock helper.
REVOKE ALL ON FUNCTION public.happy_lock_active_tenant_scope(uuid,uuid)
  FROM public, anon, authenticated, service_role;
-- This read-only predicate is intentionally callable by authenticated users
-- from the existing public RLS policy; it does not return tenant data.
REVOKE ALL ON FUNCTION public.happy_has_active_tenant_scope(uuid,uuid)
  FROM public, anon, service_role;
GRANT EXECUTE ON FUNCTION public.happy_has_active_tenant_scope(uuid,uuid)
  TO authenticated;

REVOKE ALL ON FUNCTION public.happy_create_tenant_record(uuid,uuid,text,text,jsonb)
  FROM public, anon, service_role;
GRANT EXECUTE ON FUNCTION public.happy_create_tenant_record(uuid,uuid,text,text,jsonb)
  TO authenticated;

REVOKE ALL ON FUNCTION public.happy_update_tenant_record(uuid,uuid,text,text,bigint,jsonb)
  FROM public, anon, service_role;
GRANT EXECUTE ON FUNCTION public.happy_update_tenant_record(uuid,uuid,text,text,bigint,jsonb)
  TO authenticated;

REVOKE ALL ON FUNCTION public.happy_delete_tenant_record(uuid,uuid,text,text,bigint)
  FROM public, anon, service_role;
GRANT EXECUTE ON FUNCTION public.happy_delete_tenant_record(uuid,uuid,text,text,bigint)
  TO authenticated;

-- Fail closed if any lock-only identity policy is broader than required.
DO $assert$
DECLARE bad text;
BEGIN
  SELECT format('%I.%I:%I',schemaname,tablename,policyname)
    INTO bad
    FROM pg_catalog.pg_policies
   WHERE schemaname='private'
     AND tablename IN ('organizations','workspaces','organization_memberships','workspace_memberships')
     AND cmd='UPDATE'
     AND 'happy_tenant_scope_rpc_owner'=ANY(roles)
     AND (coalesce(qual,'') <> 'true' OR coalesce(with_check,'') <> 'false')
   LIMIT 1;
  IF bad IS NOT NULL THEN
    RAISE EXCEPTION 'Tenant identity lock policy is not lock-only: %', bad;
  END IF;

  IF NOT has_column_privilege('happy_tenant_scope_rpc_owner','public.happy_tenant_records','data','UPDATE')
     OR NOT has_column_privilege('happy_tenant_scope_rpc_owner','public.happy_tenant_records','version','UPDATE')
     OR NOT has_column_privilege('happy_tenant_scope_rpc_owner','public.happy_tenant_records','updated_at','UPDATE')
     OR has_column_privilege('happy_tenant_scope_rpc_owner','public.happy_tenant_records','organization_id','UPDATE')
     OR has_column_privilege('happy_tenant_scope_rpc_owner','public.happy_tenant_records','workspace_id','UPDATE')
     OR has_column_privilege('happy_tenant_scope_rpc_owner','public.happy_tenant_records','user_id','UPDATE') THEN
    RAISE EXCEPTION 'Tenant record UPDATE columns are not exact';
  END IF;
END
$assert$;

COMMIT;
