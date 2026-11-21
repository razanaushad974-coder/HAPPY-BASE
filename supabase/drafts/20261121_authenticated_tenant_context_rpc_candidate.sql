-- DESIGN-ONLY candidate. Apply only after the private organization,
-- workspace, and membership tables exist and have been reviewed.
-- Authenticated users receive RPC execution only; direct private-table access
-- remains revoked. The caller cannot supply a user ID: auth.uid() is authority.
--
-- FUNCTION-OWNER DEPLOYMENT GATE:
-- Do not leave this SECURITY DEFINER function owned by a broad service role.
-- Before granting authenticated execution, transfer ownership to a dedicated
-- NOLOGIN role with only USAGE on private/auth, SELECT on the four identity
-- tables below, and EXECUTE on auth.uid(). Because those tables use RLS without
-- client-facing membership policies, the role's RLS-bypass behavior must be
-- deliberately constrained and reviewed. A dedicated NOLOGIN BYPASSRLS role
-- with SELECT-only grants is one candidate; never grant it membership DML or
-- use service_role as its owner. Verify the target Supabase project permits
-- the role/ownership model before applying this candidate.

create or replace function public.resolve_authenticated_tenant_context(
  p_organization_id uuid,
  p_workspace_id uuid
)
returns table (
  user_id uuid,
  organization_id uuid,
  workspace_id uuid,
  organization_role text,
  workspace_role text
)
language plpgsql
security definer
set search_path = pg_catalog
as $function$
declare
  v_user_id uuid := auth.uid();
begin
  if v_user_id is null
     or p_organization_id is null
     or p_workspace_id is null then
    return;
  end if;

  return query
  select
    v_user_id,
    o.organization_id,
    w.workspace_id,
    om.role,
    wm.role
  from private.organizations o
  join private.workspaces w
    on w.organization_id = o.organization_id
   and w.workspace_id = p_workspace_id
  join private.organization_memberships om
    on om.organization_id = o.organization_id
   and om.user_id = v_user_id
   and om.status = 'ACTIVE'
  join private.workspace_memberships wm
    on wm.organization_id = o.organization_id
   and wm.workspace_id = w.workspace_id
   and wm.user_id = v_user_id
   and wm.status = 'ACTIVE'
  where o.organization_id = p_organization_id
    and o.status = 'ACTIVE'
    and w.status = 'ACTIVE'
    and length(btrim(om.role)) > 0
    and length(btrim(wm.role)) > 0
  limit 1;
end;
$function$;

revoke all on function public.resolve_authenticated_tenant_context(uuid,uuid)
  from public, anon, service_role;
grant execute on function public.resolve_authenticated_tenant_context(uuid,uuid)
  to authenticated;
