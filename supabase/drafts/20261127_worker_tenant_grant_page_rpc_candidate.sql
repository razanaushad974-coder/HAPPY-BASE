-- HAPPY worker tenant-grant page RPC (DESIGN DRAFT ONLY)
-- Date: 2026-11-27
--
-- This is an un-applied candidate. It deliberately creates no LOGIN role,
-- grants no EXECUTE to any worker, and is not part of the migration chain.
-- Before use: verify the dedicated worker pool's session_user/current_user,
-- install the reviewed registry owner role/privileges, and grant EXECUTE only
-- to the exact verified happy_worker_* LOGIN after operator approval.
--
-- Trust boundary:
--   * The worker principal is derived from session_user by
--     happy_require_worker_principal('CONTROL').
--   * p_worker_principal_id is only a selector and must equal that DB identity.
--   * Only enabled CONTROL tenant grants with active canonical organization,
--     workspace, organization membership and workspace membership are listed.
--   * Every returned scope is revalidated again by each worker operation's
--     happy_require_worker_tenant_scope call in its own transaction.
--   * Keyset pagination is bounded and stable; no arbitrary tenant enumeration.

begin;

create or replace function private.happy_worker_list_tenant_grants(
  p_worker_principal_id uuid,
  p_after_organization_id uuid,
  p_after_workspace_id uuid,
  p_after_user_id uuid,
  p_limit integer
)
returns table (
  organization_id uuid,
  workspace_id uuid,
  user_id uuid
)
language plpgsql
security definer
set search_path = pg_catalog
as $tenant_grant_page$
declare
  v_session_principal_id uuid;
begin
  if p_worker_principal_id is null
     or p_limit is null or p_limit < 1 or p_limit > 20
     or not (
       (p_after_organization_id is null and p_after_workspace_id is null and p_after_user_id is null)
       or
       (p_after_organization_id is not null and p_after_workspace_id is not null and p_after_user_id is not null)
     ) then
    raise exception 'INVALID_WORKER_TENANT_GRANT_PAGE' using errcode = '22023';
  end if;

  select principal.worker_principal_id
    into v_session_principal_id
    from private.happy_require_worker_principal('CONTROL') principal
   where principal.worker_principal_id = p_worker_principal_id;

  if not found then
    raise exception 'WORKER_PRINCIPAL_SCOPE_MISMATCH' using errcode = '42501';
  end if;

  return query
    select g.organization_id, g.workspace_id, g.user_id
      from private.happy_worker_tenant_grants g
      join private.organizations o
        on o.organization_id = g.organization_id
       and o.status = 'ACTIVE'
      join private.workspaces w
        on w.organization_id = g.organization_id
       and w.workspace_id = g.workspace_id
       and w.status = 'ACTIVE'
      join private.organization_memberships om
        on om.organization_id = g.organization_id
       and om.user_id = g.user_id
       and om.status = 'ACTIVE'
      join private.workspace_memberships wm
        on wm.organization_id = g.organization_id
       and wm.workspace_id = g.workspace_id
       and wm.user_id = g.user_id
       and wm.status = 'ACTIVE'
     where g.worker_principal_id = v_session_principal_id
       and g.enabled = true
       and g.capabilities @> array['CONTROL']::text[]
       and (
         p_after_organization_id is null
         or row(g.organization_id, g.workspace_id, g.user_id)
              > row(p_after_organization_id, p_after_workspace_id, p_after_user_id)
       )
     order by g.organization_id, g.workspace_id, g.user_id
     limit p_limit
     for share of g, o, w, om, wm;
end;
$tenant_grant_page$;

grant create on schema private to happy_worker_registry_owner;
alter function private.happy_worker_list_tenant_grants(uuid,uuid,uuid,uuid,integer)
  owner to happy_worker_registry_owner;
revoke create on schema private from happy_worker_registry_owner;

revoke all on function private.happy_worker_list_tenant_grants(uuid,uuid,uuid,uuid,integer)
  from public, anon, authenticated, service_role;

-- Fail closed on re-application too: remove any prior direct worker-login
-- EXECUTE grants. The operator must explicitly re-grant only the verified
-- dedicated LOGIN after the hosted session_user diagnostic passes.
do $revoke_worker_execute$
declare
  v_role record;
begin
  for v_role in
    select rolname
      from pg_catalog.pg_roles
     where rolname ~ '^happy_worker_[a-z0-9_]{1,48} An operator must add the exact, verified
-- dedicated worker LOGIN role only after the hosted session_user diagnostic
-- passes. Never grant to PUBLIC, anon, authenticated, or service_role.

commit;

  loop
    execute format(
      'revoke all on function private.happy_worker_list_tenant_grants(uuid,uuid,uuid,uuid,integer) from %I',
      v_role.rolname
    );
  end loop;
end
$revoke_worker_execute$;

-- Intentionally no GRANT EXECUTE. An operator must add the exact, verified
-- dedicated worker LOGIN role only after the hosted session_user diagnostic
-- passes. Never grant to PUBLIC, anon, authenticated, or service_role.

commit;
