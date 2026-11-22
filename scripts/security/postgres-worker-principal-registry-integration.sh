#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL is required}"

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
REGISTRY_SQL="$ROOT_DIR/supabase/drafts/20261122_worker_principal_registry_candidate.sql"
if [[ ! -f "$REGISTRY_SQL" ]]; then
  echo "Worker principal registry SQL draft not found: $REGISTRY_SQL" >&2
  exit 1
fi

psql=(psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1)

"${psql[@]}" <<'SQL'
do $roles$
begin
  create role authenticated nologin;
exception when duplicate_object then null;
end
$roles$;
do $roles$
begin
  create role anon nologin;
exception when duplicate_object then null;
end
$roles$;
do $roles$
begin
  create role service_role nologin;
exception when duplicate_object then null;
end
$roles$;
do $roles$
begin
  create role happy_worker_dispatch login noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
exception when duplicate_object then null;
end
$roles$;
do $roles$
begin
  create role happy_worker_registry_owner nologin noinherit nosuperuser nocreatedb nocreaterole noreplication nobypassrls;
exception when duplicate_object then null;
end
$roles$;

create schema if not exists auth;
create schema if not exists private;
create table if not exists auth.users (id uuid primary key);
create table if not exists private.organizations (
  organization_id uuid primary key,
  status text not null default 'ACTIVE'
);
create table if not exists private.workspaces (
  workspace_id uuid primary key,
  organization_id uuid not null references private.organizations(organization_id),
  status text not null default 'ACTIVE',
  unique (organization_id, workspace_id)
);
create table if not exists private.organization_memberships (
  organization_id uuid not null references private.organizations(organization_id),
  user_id uuid not null references auth.users(id),
  status text not null,
  role text not null,
  primary key (organization_id, user_id)
);
create table if not exists private.workspace_memberships (
  organization_id uuid not null,
  workspace_id uuid not null,
  user_id uuid not null references auth.users(id),
  status text not null,
  role text not null,
  primary key (organization_id, workspace_id, user_id),
  foreign key (organization_id, workspace_id)
    references private.workspaces(organization_id, workspace_id)
);

insert into auth.users(id)
values
  ('30000000-0000-4000-8000-000000000003'),
  ('40000000-0000-4000-8000-000000000004')
on conflict do nothing;
insert into private.organizations(organization_id,status)
values ('10000000-0000-4000-8000-000000000001','ACTIVE')
on conflict do nothing;
insert into private.workspaces(workspace_id,organization_id,status)
values (
  '20000000-0000-4000-8000-000000000002',
  '10000000-0000-4000-8000-000000000001',
  'ACTIVE'
)
on conflict do nothing;
insert into private.organization_memberships(organization_id,user_id,status,role)
values
  ('10000000-0000-4000-8000-000000000001','30000000-0000-4000-8000-000000000003','ACTIVE','MEMBER'),
  ('10000000-0000-4000-8000-000000000001','40000000-0000-4000-8000-000000000004','ACTIVE','MEMBER')
on conflict do nothing;
insert into private.workspace_memberships(organization_id,workspace_id,user_id,status,role)
values
  ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','30000000-0000-4000-8000-000000000003','ACTIVE','MEMBER'),
  ('10000000-0000-4000-8000-000000000001','20000000-0000-4000-8000-000000000002','40000000-0000-4000-8000-000000000004','ACTIVE','MEMBER')
on conflict do nothing;
SQL

"${psql[@]}" -f "$REGISTRY_SQL"

"${psql[@]}" <<'SQL'
-- Use a non-login, non-privileged SECURITY DEFINER owner in the test as well.
grant usage on schema private to happy_worker_registry_owner;
grant select on private.happy_worker_principal_registry,
  private.happy_worker_tenant_grants, private.organizations, private.workspaces,
  private.organization_memberships, private.workspace_memberships
  to happy_worker_registry_owner;
-- SELECT FOR SHARE requires UPDATE privilege. Limit the non-login function
-- owner to one status/activation column per table; it receives no table-wide
-- UPDATE and no runtime login is granted this authority.
grant update (enabled) on private.happy_worker_principal_registry,
  private.happy_worker_tenant_grants to happy_worker_registry_owner;
grant update (status) on private.organizations, private.workspaces,
  private.organization_memberships, private.workspace_memberships
  to happy_worker_registry_owner;
grant create on schema private to happy_worker_registry_owner;
alter function private.happy_require_worker_principal(text)
  owner to happy_worker_registry_owner;
alter function private.happy_require_worker_tenant_scope(uuid,uuid,uuid,uuid,text)
  owner to happy_worker_registry_owner;
revoke create on schema private from happy_worker_registry_owner;
grant usage on schema private to happy_worker_dispatch;
grant execute on function private.happy_require_worker_principal(text),
  private.happy_require_worker_tenant_scope(uuid,uuid,uuid,uuid,text)
  to happy_worker_dispatch;

insert into private.happy_worker_principal_registry (
  worker_principal_id, db_login_role, issuer, subject, audience, environment,
  capabilities, enabled, activated_at
) values (
  '60000000-0000-4000-8000-000000000006',
  'happy_worker_dispatch',
  'https://issuer.example.test',
  'worker/dispatch',
  'happy-worker',
  'test',
  array['CONTROL','VERIFY'],
  true,
  clock_timestamp()
);

insert into private.happy_worker_tenant_grants (
  worker_principal_id, organization_id, workspace_id, user_id,
  capabilities, enabled
) values (
  '60000000-0000-4000-8000-000000000006',
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  '30000000-0000-4000-8000-000000000003',
  array['CONTROL','VERIFY'],
  true
);

do $invalid_capabilities$
begin
  begin
    insert into private.happy_worker_principal_registry (
      worker_principal_id, db_login_role, issuer, subject, audience, environment,
      capabilities
    ) values (
      gen_random_uuid(), 'happy_worker_invalid', 'issuer', 'subject', 'audience',
      'test', array['CONTROL','CONTROL']
    );
    raise exception 'duplicate worker capabilities unexpectedly accepted';
  exception when check_violation then null;
  end;
end
$invalid_capabilities$;

do $least_privilege$
begin
  if has_table_privilege('happy_worker_dispatch',
      'private.happy_worker_principal_registry','SELECT')
     or has_table_privilege('happy_worker_dispatch',
      'private.happy_worker_tenant_grants','SELECT')
     or has_table_privilege('authenticated',
      'private.happy_worker_principal_registry','SELECT')
     or has_table_privilege('service_role',
      'private.happy_worker_principal_registry','SELECT') then
    raise exception 'worker registry tables are directly readable by runtime/API roles';
  end if;
  if has_function_privilege('authenticated',
      'private.happy_require_worker_principal(text)','EXECUTE')
     or has_function_privilege('service_role',
      'private.happy_require_worker_principal(text)','EXECUTE')
     or not has_function_privilege('happy_worker_dispatch',
      'private.happy_require_worker_principal(text)','EXECUTE') then
    raise exception 'worker principal helper grants are not least-privilege';
  end if;
end
$least_privilege$;
SQL

"${psql[@]}" <<'SQL'
select 'registry-precheck' as check_name, db_login_role, enabled,
       activated_at is not null as activated, revoked_at,
       capabilities
  from private.happy_worker_principal_registry
 where db_login_role = 'happy_worker_dispatch';

set role happy_worker_registry_owner;
select 'organization-membership-lock' as check_name, status
  from private.organization_memberships
 where organization_id = '10000000-0000-4000-8000-000000000001'
   and user_id = '30000000-0000-4000-8000-000000000003'
 for share;
select 'workspace-membership-lock' as check_name, status
  from private.workspace_memberships
 where organization_id = '10000000-0000-4000-8000-000000000001'
   and workspace_id = '20000000-0000-4000-8000-000000000002'
   and user_id = '30000000-0000-4000-8000-000000000003'
 for share;
reset role;

set session authorization happy_worker_dispatch;
select 'worker-session-diagnostic' as check_name,
       session_user::text as session_user,
       current_user::text as current_user;

do $worker_identity$
declare
  v_principal record;
begin
  if session_user::text <> 'happy_worker_dispatch' then
    raise exception 'worker session authorization did not switch to the dedicated LOGIN role';
  end if;

  select * into v_principal
    from private.happy_require_worker_principal('CONTROL');
  if not found
     or v_principal.worker_principal_id <> '60000000-0000-4000-8000-000000000006'
     or v_principal.subject <> 'worker/dispatch'
     or v_principal.environment <> 'test' then
    raise exception 'dedicated PostgreSQL LOGIN role did not resolve the registered worker principal';
  end if;

  select * into v_principal
    from private.happy_require_worker_principal('VERIFY');
  if not found then raise exception 'registered VERIFY capability was denied'; end if;

  if private.happy_require_worker_tenant_scope(
    '60000000-0000-4000-8000-000000000006',
    '10000000-0000-4000-8000-000000000001',
    '20000000-0000-4000-8000-000000000002',
    '30000000-0000-4000-8000-000000000003',
    'CONTROL'
  ) <> '30000000-0000-4000-8000-000000000003' then
    raise exception 'active worker tenant grant did not resolve its mapped user';
  end if;

  begin
    perform private.happy_require_worker_tenant_scope(
      '60000000-0000-4000-8000-000000000006',
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      '40000000-0000-4000-8000-000000000004',
      'CONTROL'
    );
    raise exception 'ungranted user scope unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;

  begin
    perform * from private.happy_require_worker_principal('API');
    raise exception 'unregistered worker capability unexpectedly succeeded';
  exception when insufficient_privilege then null;
  end;
end
$worker_identity$;

reset session authorization;

update private.workspace_memberships
   set status = 'REVOKED'
 where organization_id = '10000000-0000-4000-8000-000000000001'
   and workspace_id = '20000000-0000-4000-8000-000000000002'
   and user_id = '30000000-0000-4000-8000-000000000003';

set session authorization happy_worker_dispatch;
do $revoked_membership$
begin
  begin
    perform private.happy_require_worker_tenant_scope(
      '60000000-0000-4000-8000-000000000006',
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002',
      '30000000-0000-4000-8000-000000000003',
      'CONTROL'
    );
    raise exception 'revoked workspace membership unexpectedly authorized worker scope';
  exception when insufficient_privilege then null;
  end;
end
$revoked_membership$;
reset session authorization;

-- A human/application DB role cannot resolve the worker principal, even if it
-- attempts to use the same function. The session_user is the authority.
set role authenticated;
do $human_denial$
begin
  begin
    perform * from private.happy_require_worker_principal('CONTROL');
    raise exception 'authenticated user unexpectedly resolved worker identity';
  exception when insufficient_privilege then null;
  end;
end
$human_denial$;
reset role;

-- Operator revocation is effective on the next transaction/function call.
update private.happy_worker_principal_registry
   set enabled = false, revoked_at = clock_timestamp(), updated_at = clock_timestamp()
 where db_login_role = 'happy_worker_dispatch';

set session authorization happy_worker_dispatch;
do $revoked_worker$
begin
  begin
    perform * from private.happy_require_worker_principal('CONTROL');
    raise exception 'revoked worker unexpectedly resolved';
  exception when insufficient_privilege then null;
  end;
end
$revoked_worker$;
reset session authorization;

select 'PostgreSQL worker principal registry integration: PASS (isolated PostgreSQL roles; no hosted Supabase)' as result;
SQL
