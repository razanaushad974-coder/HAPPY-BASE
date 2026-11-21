-- DESIGN-ONLY candidate. Requires private.execution_requests from
-- 20261119_file_mutation_atomic_consume_candidate.sql to exist first.
-- This RPC replaces direct authenticated reads from private.execution_requests.
-- The only request selector is an opaque ID; auth.uid() is the executor authority.

create or replace function public.resolve_authenticated_execution_request(
  p_request_id text
)
returns table (
  request_id text,
  task_id text,
  mission_id text,
  requester_user_id uuid,
  executor_user_id uuid,
  organization_id uuid,
  workspace_id uuid
)
language sql
security definer
set search_path = pg_catalog
as $function$
  select
    r.request_id,
    r.task_id,
    r.mission_id,
    r.requester_user_id,
    r.executor_user_id,
    r.organization_id,
    r.workspace_id
  from private.execution_requests r
  where p_request_id is not null
    and length(btrim(p_request_id)) > 0
    and r.request_id = p_request_id
    and r.executor_user_id = auth.uid()
    and r.status = 'READY'
  limit 1;
$function$;

-- Use a dedicated, non-login function owner, never service_role. BYPASSRLS
-- is limited by SELECT-only access to execution_requests. Validate role
-- creation/ownership permissions and the hosted table/RLS model before apply.
do $role$
begin
  create role happy_execution_request_rpc_owner nologin bypassrls;
exception when duplicate_object then null;
end
$role$;

grant usage on schema private, auth to happy_execution_request_rpc_owner;
grant select on private.execution_requests to happy_execution_request_rpc_owner;
grant execute on function auth.uid() to happy_execution_request_rpc_owner;

alter function public.resolve_authenticated_execution_request(text)
  owner to happy_execution_request_rpc_owner;

revoke all on function public.resolve_authenticated_execution_request(text)
  from public, anon, service_role;
grant execute on function public.resolve_authenticated_execution_request(text)
  to authenticated;

do $privileges$
begin
  if not has_table_privilege('happy_execution_request_rpc_owner',
      'private.execution_requests', 'SELECT') then
    raise exception 'execution request RPC owner lacks required SELECT privilege';
  end if;
  if has_table_privilege('happy_execution_request_rpc_owner',
      'private.execution_requests', 'INSERT,UPDATE,DELETE') then
    raise exception 'execution request RPC owner unexpectedly has write privileges';
  end if;
  if not has_function_privilege('authenticated',
      'public.resolve_authenticated_execution_request(text)', 'EXECUTE')
     or has_function_privilege('anon',
      'public.resolve_authenticated_execution_request(text)', 'EXECUTE')
     or has_function_privilege('service_role',
      'public.resolve_authenticated_execution_request(text)', 'EXECUTE') then
    raise exception 'execution request RPC grants are not least-privilege';
  end if;
end
$privileges$;
