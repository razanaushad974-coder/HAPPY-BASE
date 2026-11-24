-- DESIGN-ONLY least-privilege grant/ownership candidate.
-- Prerequisites:
--   1) canonical private organization/workspace/membership tables exist;
--   2) worker registry tables and SELECT RLS policies exist;
--   3) happy_worker_registry_owner was provisioned by the prior candidate.
-- DO NOT APPLY to a connected/shared/production project.
BEGIN;

GRANT USAGE ON SCHEMA private TO happy_worker_registry_owner;

-- Exact read columns used by happy_require_worker_principal().
GRANT SELECT (
  worker_principal_id, db_login_role, issuer, subject, audience,
  environment, capabilities, enabled, activated_at, revoked_at
) ON private.happy_worker_principal_registry TO happy_worker_registry_owner;

-- Exact read columns used by happy_require_worker_tenant_scope().
GRANT SELECT (
  worker_principal_id, organization_id, workspace_id, user_id,
  capabilities, enabled
) ON private.happy_worker_tenant_grants TO happy_worker_registry_owner;

GRANT SELECT (organization_id, status)
  ON private.organizations TO happy_worker_registry_owner;
GRANT SELECT (organization_id, workspace_id, status)
  ON private.workspaces TO happy_worker_registry_owner;
GRANT SELECT (organization_id, user_id, status)
  ON private.organization_memberships TO happy_worker_registry_owner;
GRANT SELECT (organization_id, workspace_id, user_id, status)
  ON private.workspace_memberships TO happy_worker_registry_owner;

-- FOR SHARE needs an UPDATE SQL privilege and an UPDATE RLS policy whose
-- USING expression admits the row. The matching lock-only policies in the
-- registry candidate use USING (true) WITH CHECK (false), so mutations fail.
-- These column grants exist only for row-lock syntax. Never widen WITH CHECK.
GRANT UPDATE (enabled)
  ON private.happy_worker_principal_registry TO happy_worker_registry_owner;
GRANT UPDATE (enabled)
  ON private.happy_worker_tenant_grants TO happy_worker_registry_owner;
GRANT UPDATE (status)
  ON private.organizations TO happy_worker_registry_owner;
GRANT UPDATE (status)
  ON private.workspaces TO happy_worker_registry_owner;
GRANT UPDATE (status)
  ON private.organization_memberships TO happy_worker_registry_owner;
GRANT UPDATE (status)
  ON private.workspace_memberships TO happy_worker_registry_owner;

-- RLS predicate for scheduler-owned tables. It derives the worker from
-- PostgreSQL session_user, then rechecks the live worker->tenant grant and
-- canonical membership on every policy evaluation. Exceptions fail closed.
CREATE OR REPLACE FUNCTION private.happy_worker_tenant_scope_policy(
  p_organization_id uuid,
  p_workspace_id uuid,
  p_user_id uuid,
  p_required_capability text
)
RETURNS boolean
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog
AS $worker_scope_policy$
DECLARE
  v_worker_principal_id uuid;
  v_actor_id uuid;
BEGIN
  IF p_organization_id IS NULL OR p_workspace_id IS NULL
     OR p_user_id IS NULL OR p_required_capability IS NULL THEN
    RETURN false;
  END IF;

  SELECT principal.worker_principal_id
    INTO v_worker_principal_id
    FROM private.happy_require_worker_principal(p_required_capability) principal
   LIMIT 1;

  IF NOT FOUND THEN RETURN false; END IF;

  v_actor_id := private.happy_require_worker_tenant_scope(
    v_worker_principal_id,
    p_organization_id,
    p_workspace_id,
    p_user_id,
    p_required_capability
  );

  RETURN v_actor_id IS NOT NULL AND v_actor_id = p_user_id;
EXCEPTION
  WHEN OTHERS THEN
    RETURN false;
END
$worker_scope_policy$;

-- The role must be able to become owner of functions in private. CREATE is
-- temporary and revoked immediately after ownership transfer.
GRANT CREATE ON SCHEMA private TO happy_worker_registry_owner;

ALTER FUNCTION private.happy_require_worker_principal(text)
  OWNER TO happy_worker_registry_owner;
ALTER FUNCTION private.happy_require_worker_tenant_scope(uuid,uuid,uuid,uuid,text)
  OWNER TO happy_worker_registry_owner;
ALTER FUNCTION private.happy_worker_tenant_scope_policy(uuid,uuid,uuid,text)
  OWNER TO happy_worker_registry_owner;

REVOKE CREATE ON SCHEMA private FROM happy_worker_registry_owner;

REVOKE ALL ON FUNCTION private.happy_worker_tenant_scope_policy(uuid,uuid,uuid,text)
  FROM public, anon, authenticated, service_role;
GRANT EXECUTE ON FUNCTION private.happy_worker_tenant_scope_policy(uuid,uuid,uuid,text)
  TO happy_worker_scheduler_rpc_owner;

-- Keep helper functions private; no API role or worker LOGIN gets EXECUTE.
REVOKE ALL ON FUNCTION private.happy_require_worker_principal(text)
  FROM public, anon, authenticated, service_role;
REVOKE ALL ON FUNCTION private.happy_require_worker_tenant_scope(uuid,uuid,uuid,uuid,text)
  FROM public, anon, authenticated, service_role;

-- The only UPDATE policies for this owner must be lock-only:
-- USING (true) WITH CHECK (false). This lets FOR SHARE see and lock a row,
-- while every UPDATE fails its new-row check. Any broader policy is a blocker.
DO $assert$
DECLARE
  v_bad_policy text;
BEGIN
  SELECT format('%I.%I:%I', schemaname, tablename, policyname)
    INTO v_bad_policy
    FROM pg_catalog.pg_policies
   WHERE schemaname = 'private'
     AND tablename IN (
       'happy_worker_principal_registry',
       'happy_worker_tenant_grants',
       'organizations',
       'workspaces',
       'organization_memberships',
       'workspace_memberships'
     )
     AND cmd = 'UPDATE'
     AND (
       'public' = ANY(roles)
       OR 'happy_worker_registry_owner' = ANY(roles)
     )
     AND (
       coalesce(qual, '') <> 'true'
       OR coalesce(with_check, '') <> 'false'
     )
   LIMIT 1;

  IF v_bad_policy IS NOT NULL THEN
    RAISE EXCEPTION 'Non-lock-only UPDATE RLS policy for registry owner: %', v_bad_policy;
  END IF;

  IF has_table_privilege('happy_worker_registry_owner',
       'private.happy_worker_principal_registry', 'INSERT')
     OR has_table_privilege('happy_worker_registry_owner',
       'private.happy_worker_principal_registry', 'DELETE')
     OR has_table_privilege('happy_worker_registry_owner',
       'private.happy_worker_tenant_grants', 'INSERT')
     OR has_table_privilege('happy_worker_registry_owner',
       'private.happy_worker_tenant_grants', 'DELETE') THEN
    RAISE EXCEPTION 'Registry owner unexpectedly has INSERT or DELETE';
  END IF;
END
$assert$;

COMMIT;
