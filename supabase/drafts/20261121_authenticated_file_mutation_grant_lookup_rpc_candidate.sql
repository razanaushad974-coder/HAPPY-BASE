-- DESIGN-ONLY candidate. Do not apply to a connected/shared Supabase project.
-- Requires private.file_mutation_approval_grants and its referenced tenant/request
-- tables from 20261119_file_mutation_atomic_consume_candidate.sql.
-- Grant discovery is executor-bound: auth.uid() is the only executor authority.
-- Consumption remains a separate atomic transaction RPC.

create or replace function public.resolve_authenticated_file_mutation_approval_grant(
  p_organization_id uuid,
  p_workspace_id uuid,
  p_request_id text,
  p_task_id text,
  p_mission_id text,
  p_requester_user_id uuid,
  p_target_entity_id text,
  p_operation text,
  p_source_path text,
  p_destination_path text,
  p_input_digest text
)
returns table (
  grant_id uuid,
  request_id text,
  task_id text,
  mission_id text,
  requester_user_id uuid,
  executor_user_id uuid,
  approver_user_id uuid,
  organization_id uuid,
  workspace_id uuid,
  target_entity_type text,
  target_entity_id text,
  operation text,
  source_path text,
  destination_path text,
  input_digest text,
  required_role text,
  status text,
  expires_at timestamptz,
  consumed_at timestamptz
)
language sql
security definer
set search_path = pg_catalog
as $function$
  select
    g.grant_id,
    g.request_id,
    g.task_id,
    g.mission_id,
    g.requester_user_id,
    g.executor_user_id,
    g.approver_user_id,
    g.organization_id,
    g.workspace_id,
    g.target_entity_type,
    g.target_entity_id,
    g.operation,
    g.source_path,
    g.destination_path,
    g.input_digest,
    g.required_role,
    g.status,
    g.expires_at,
    g.consumed_at
  from private.file_mutation_approval_grants g
  join private.execution_requests r
    on r.request_id = g.request_id
   and r.task_id = g.task_id
   and r.mission_id = g.mission_id
   and r.requester_user_id = g.requester_user_id
   and r.executor_user_id = g.executor_user_id
   and r.organization_id = g.organization_id
   and r.workspace_id = g.workspace_id
  join private.organizations o
    on o.organization_id = g.organization_id
   and o.status = 'ACTIVE'
  join private.workspaces w
    on w.organization_id = g.organization_id
   and w.workspace_id = g.workspace_id
   and w.status = 'ACTIVE'
  where auth.uid() is not null
    and g.executor_user_id = auth.uid()
    and r.executor_user_id = auth.uid()
    and r.status = 'READY'
    and g.organization_id = p_organization_id
    and g.workspace_id = p_workspace_id
    and g.request_id = p_request_id
    and g.task_id = p_task_id
    and g.mission_id = p_mission_id
    and g.requester_user_id = p_requester_user_id
    and g.target_entity_type = 'FILE'
    and g.target_entity_id = p_target_entity_id
    and g.operation = p_operation
    and g.source_path = p_source_path
    and g.destination_path is not distinct from p_destination_path
    and g.input_digest = p_input_digest
    and g.status = 'APPROVED'
    and g.decided_at is not null
    and g.consumed_at is null
    and g.expires_at > clock_timestamp()
    and p_operation in ('CREATE','MODIFY','COPY','MOVE','RENAME','DELETE')
    and p_input_digest ~ '^[0-9a-f]{64}$';
$function$;

-- Dedicated non-login read-only function owner. Never use service_role.
do $role$
begin
  create role happy_file_grant_lookup_rpc_owner nologin bypassrls;
exception when duplicate_object then null;
end
$role$;

grant usage on schema private, auth to happy_file_grant_lookup_rpc_owner;
grant select on private.file_mutation_approval_grants,
  private.execution_requests, private.organizations, private.workspaces
  to happy_file_grant_lookup_rpc_owner;
grant execute on function auth.uid() to happy_file_grant_lookup_rpc_owner;

alter function public.resolve_authenticated_file_mutation_approval_grant(
  uuid,uuid,text,text,text,uuid,text,text,text,text,text
) owner to happy_file_grant_lookup_rpc_owner;

revoke all on function public.resolve_authenticated_file_mutation_approval_grant(
  uuid,uuid,text,text,text,uuid,text,text,text,text,text
) from public, anon, service_role;
grant execute on function public.resolve_authenticated_file_mutation_approval_grant(
  uuid,uuid,text,text,text,uuid,text,text,text,text,text
) to authenticated;

do $privileges$
begin
  if not has_table_privilege('happy_file_grant_lookup_rpc_owner',
      'private.file_mutation_approval_grants', 'SELECT')
     or not has_table_privilege('happy_file_grant_lookup_rpc_owner',
      'private.execution_requests', 'SELECT')
     or not has_table_privilege('happy_file_grant_lookup_rpc_owner',
      'private.organizations', 'SELECT')
     or not has_table_privilege('happy_file_grant_lookup_rpc_owner',
      'private.workspaces', 'SELECT') then
    raise exception 'file grant lookup RPC owner lacks required SELECT privileges';
  end if;
  if has_table_privilege('happy_file_grant_lookup_rpc_owner',
      'private.file_mutation_approval_grants', 'INSERT,UPDATE,DELETE')
     or has_table_privilege('happy_file_grant_lookup_rpc_owner',
      'private.execution_requests', 'INSERT,UPDATE,DELETE') then
    raise exception 'file grant lookup RPC owner unexpectedly has write privileges';
  end if;
  if not has_function_privilege('authenticated',
      'public.resolve_authenticated_file_mutation_approval_grant(uuid,uuid,text,text,text,uuid,text,text,text,text,text)', 'EXECUTE')
     or has_function_privilege('anon',
      'public.resolve_authenticated_file_mutation_approval_grant(uuid,uuid,text,text,text,uuid,text,text,text,text,text)', 'EXECUTE')
     or has_function_privilege('service_role',
      'public.resolve_authenticated_file_mutation_approval_grant(uuid,uuid,text,text,text,uuid,text,text,text,text,text)', 'EXECUTE') then
    raise exception 'file grant lookup RPC grants are not least-privilege';
  end if;
end
$privileges$;
