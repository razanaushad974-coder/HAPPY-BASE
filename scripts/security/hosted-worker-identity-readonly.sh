#!/usr/bin/env bash
set -euo pipefail

: "${HAPPY_STAGING_WORKER_DATABASE_URL:?Set HAPPY_STAGING_WORKER_DATABASE_URL to the exact dedicated worker hosted pooler connection string}"

# READ-ONLY diagnostic. This script issues SELECT/DO assertions only.
# It does not create roles, grant privileges, alter schema, or mutate rows.
exec psql "$HAPPY_STAGING_WORKER_DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
\echo 'HAPPY hosted worker identity diagnostic (read-only)'
SELECT
  session_user::text AS authenticated_session_user,
  current_user::text AS effective_current_user,
  current_database() AS database_name,
  inet_server_addr()::text AS server_address,
  inet_server_port() AS server_port,
  current_setting('transaction_read_only') AS transaction_read_only,
  current_setting('server_version') AS postgres_version;

DO $identity$
DECLARE
  worker pg_catalog.pg_roles%ROWTYPE;
  registry_owner pg_catalog.pg_roles%ROWTYPE;
  scheduler_owner pg_catalog.pg_roles%ROWTYPE;
BEGIN
  IF session_user::text <> 'happy_worker_dispatch' THEN
    RAISE EXCEPTION 'Expected authenticated session_user happy_worker_dispatch; got %', session_user;
  END IF;
  IF current_user::text <> 'happy_worker_dispatch' THEN
    RAISE EXCEPTION 'Unexpected effective current_user %; expected happy_worker_dispatch', current_user;
  END IF;

  SELECT * INTO worker FROM pg_catalog.pg_roles WHERE rolname = 'happy_worker_dispatch';
  IF NOT FOUND
     OR worker.rolcanlogin IS DISTINCT FROM true
     OR worker.rolinherit IS DISTINCT FROM false
     OR worker.rolsuper IS DISTINCT FROM false
     OR worker.rolcreatedb IS DISTINCT FROM false
     OR worker.rolcreaterole IS DISTINCT FROM false
     OR worker.rolreplication IS DISTINCT FROM false
     OR worker.rolbypassrls IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Dedicated worker LOGIN role is missing or has unsafe role attributes';
  END IF;

  SELECT * INTO registry_owner FROM pg_catalog.pg_roles
   WHERE rolname = 'happy_worker_registry_owner';
  IF NOT FOUND
     OR registry_owner.rolcanlogin IS DISTINCT FROM false
     OR registry_owner.rolinherit IS DISTINCT FROM false
     OR registry_owner.rolsuper IS DISTINCT FROM false
     OR registry_owner.rolbypassrls IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Worker registry function owner is missing or not restricted NOLOGIN/NOINHERIT/NOBYPASSRLS';
  END IF;

  SELECT * INTO scheduler_owner FROM pg_catalog.pg_roles
   WHERE rolname = 'happy_worker_scheduler_rpc_owner';
  IF NOT FOUND
     OR scheduler_owner.rolcanlogin IS DISTINCT FROM false
     OR scheduler_owner.rolinherit IS DISTINCT FROM false
     OR scheduler_owner.rolsuper IS DISTINCT FROM false
     OR scheduler_owner.rolbypassrls IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'Worker scheduler function owner is missing or not restricted NOLOGIN/NOINHERIT/NOBYPASSRLS';
  END IF;

  IF pg_catalog.pg_has_role(session_user, 'happy_worker_registry_owner', 'MEMBER')
     OR pg_catalog.pg_has_role(session_user, 'happy_worker_scheduler_rpc_owner', 'MEMBER') THEN
    RAISE EXCEPTION 'Worker LOGIN must not be a member of a SECURITY DEFINER owner role';
  END IF;

  IF pg_catalog.has_table_privilege(session_user, 'public.happy_tenant_records', 'SELECT')
     OR pg_catalog.has_table_privilege(session_user, 'public.happy_mission_task_leases', 'SELECT')
     OR pg_catalog.has_table_privilege(session_user, 'public.happy_execution_dispatch_outbox', 'SELECT')
     OR pg_catalog.has_table_privilege(session_user, 'private.execution_requests', 'SELECT')
     OR pg_catalog.has_table_privilege(session_user, 'private.happy_worker_principal_registry', 'SELECT')
     OR pg_catalog.has_table_privilege(session_user, 'private.happy_worker_tenant_grants', 'SELECT')
     OR pg_catalog.has_table_privilege(session_user, 'public.happy_dispatch_reconciliation_evidence', 'SELECT') THEN
    RAISE EXCEPTION 'Worker LOGIN has direct table SELECT; access must remain behind scoped RPCs';
  END IF;
END
$identity$;

SELECT 1 AS hosted_worker_identity_readonly_check_passed;
SQL
