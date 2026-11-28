#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGPORT:?PGPORT is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${PGDATABASE:?PGDATABASE is required}"

export PGPASSWORD
psql_base=(psql -X -v ON_ERROR_STOP=1)

# Seed a version-1 row as the authenticated user.
"${psql_base[@]}" <<'SQL'
set role authenticated;
select set_config('request.jwt.claim.sub',
  '30000000-0000-4000-8000-000000000003', false);
select * from public.happy_create_tenant_record(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  'MISSION', 'cas-concurrent-race', '{"goal":"race"}'
);
SQL

holder_log="$(mktemp)"
contender_log="$(mktemp)"
trap 'rm -f "$holder_log" "$contender_log"' EXIT

# The holder acquires a row lock as the database owner because authenticated
# deliberately has no direct UPDATE privilege. It switches to authenticated
# only after the lock is held, then performs the authorized CAS update.
PGAPPNAME=happy-tenant-cas-holder "${psql_base[@]}" >"$holder_log" 2>&1 <<'SQL' &
begin;
select record_id
  from public.happy_tenant_records
 where organization_id = '10000000-0000-4000-8000-000000000001'
   and workspace_id = '20000000-0000-4000-8000-000000000002'
   and record_id = 'cas-concurrent-race'
 for update;
select pg_sleep(3);
set local role authenticated;
select set_config('request.jwt.claim.sub',
  '30000000-0000-4000-8000-000000000003', true);
select (public.happy_update_tenant_record(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  'MISSION', 'cas-concurrent-race', 1, '{"goal":"holder-wins"}'
)).version;
commit;
SQL
holder_pid=$!

# Confirm the holder acquired its row lock and entered pg_sleep before starting
# the contender; this prevents process-start scheduling from deciding the winner.
holder_lock_ready=false
for _ in $(seq 1 200); do
  if "${psql_base[@]}" -Atqc "select 1 from pg_stat_activity where application_name = 'happy-tenant-cas-holder' and state = 'active' and wait_event = 'PgSleep' limit 1" | grep -q '^1$'; then
    holder_lock_ready=true
    break
  fi
  sleep 0.05
done
if [[ "$holder_lock_ready" != "true" ]]; then
  kill "$holder_pid" 2>/dev/null || true
  echo "CAS holder did not acquire its row lock before the contender started." >&2
  cat "$holder_log" >&2
  exit 1
fi

# The contender attempts the same expected version and must block behind the
# holder, then receive SQLSTATE 40001 after the holder commits version 2.
PGAPPNAME=happy-tenant-cas-contender "${psql_base[@]}" -v VERBOSITY=verbose >"$contender_log" 2>&1 <<'SQL' &
set role authenticated;
select set_config('request.jwt.claim.sub',
  '30000000-0000-4000-8000-000000000003', false);
select (public.happy_update_tenant_record(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  'MISSION', 'cas-concurrent-race', 1, '{"goal":"contender-loses"}'
)).version;
SQL
contender_pid=$!

lock_seen=false
for _ in $(seq 1 200); do
  if "${psql_base[@]}" -Atqc "select 1 from pg_stat_activity where application_name = 'happy-tenant-cas-contender' and state = 'active' and wait_event_type = 'Lock' limit 1" | grep -q '^1$'; then
    lock_seen=true
    break
  fi
  sleep 0.05
done

if [[ "$lock_seen" != "true" ]]; then
  kill "$holder_pid" "$contender_pid" 2>/dev/null || true
  echo "CAS contender did not enter a PostgreSQL lock wait." >&2
  cat "$holder_log" "$contender_log" >&2
  exit 1
fi

set +e
wait "$holder_pid"
holder_status=$?
wait "$contender_pid"
contender_status=$?
set -e

if [[ "$holder_status" -ne 0 || "$contender_status" -eq 0 ]] ||
   ! grep -q '40001' "$contender_log"; then
  echo "Concurrent CAS did not produce exactly one version-1 winner." >&2
  echo "--- holder ---" >&2
  cat "$holder_log" >&2
  echo "--- contender ---" >&2
  cat "$contender_log" >&2
  exit 1
fi

echo "PostgreSQL concurrent tenant CAS single-winner test: PASS"

# Next, serialize a workspace-membership revocation against a new create. The
# revocation obtains its row lock first; the create RPC must wait and then deny
# the write after it rechecks the now-REVOKED membership.
: >"$holder_log"
: >"$contender_log"

PGAPPNAME=happy-tenant-membership-revoke-holder "${psql_base[@]}" >"$holder_log" 2>&1 <<'SQL' &
begin;
select user_id
  from private.workspace_memberships
 where organization_id = '10000000-0000-4000-8000-000000000001'
   and workspace_id = '20000000-0000-4000-8000-000000000002'
   and user_id = '30000000-0000-4000-8000-000000000003'
 for update;
select pg_sleep(3);
update private.workspace_memberships
   set status = 'REVOKED'
 where organization_id = '10000000-0000-4000-8000-000000000001'
   and workspace_id = '20000000-0000-4000-8000-000000000002'
   and user_id = '30000000-0000-4000-8000-000000000003';
commit;
SQL
revoke_holder_pid=$!

revoke_lock_ready=false
for _ in $(seq 1 200); do
  if "${psql_base[@]}" -Atqc "select 1 from pg_stat_activity where application_name = 'happy-tenant-membership-revoke-holder' and state = 'active' and wait_event = 'PgSleep' limit 1" | grep -q '^1'; then
    revoke_lock_ready=true
    break
  fi
  sleep 0.05
done
if [[ "$revoke_lock_ready" != "true" ]]; then
  kill "$revoke_holder_pid" 2>/dev/null || true
  echo "Membership revocation holder did not acquire its row lock." >&2
  cat "$holder_log" >&2
  exit 1
fi

PGAPPNAME=happy-tenant-membership-create-contender "${psql_base[@]}" -v VERBOSITY=verbose >"$contender_log" 2>&1 <<'SQL' &
set role authenticated;
select set_config('request.jwt.claim.sub',
  '30000000-0000-4000-8000-000000000003', false);
select * from public.happy_create_tenant_record(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  'MISSION', 'create-after-membership-revoke', '{"goal":"must be denied"}'
);
SQL
revoke_contender_pid=$!

revoke_wait_seen=false
for _ in $(seq 1 200); do
  if "${psql_base[@]}" -Atqc "select 1 from pg_stat_activity where application_name = 'happy-tenant-membership-create-contender' and state = 'active' and wait_event_type = 'Lock' limit 1" | grep -q '^1'; then
    revoke_wait_seen=true
    break
  fi
  sleep 0.05
done
if [[ "$revoke_wait_seen" != "true" ]]; then
  kill "$revoke_holder_pid" "$revoke_contender_pid" 2>/dev/null || true
  echo "Create RPC did not wait on the membership revocation lock." >&2
  cat "$holder_log" "$contender_log" >&2
  exit 1
fi

set +e
wait "$revoke_holder_pid"
revoke_holder_status=$?
wait "$revoke_contender_pid"
revoke_contender_status=$?
set -e

if [[ "$revoke_holder_status" -ne 0 || "$revoke_contender_status" -eq 0 ]] ||
   ! grep -q '42501' "$contender_log"; then
  echo "Membership revocation did not deny the waiting create RPC." >&2
  echo "--- revocation holder ---" >&2
  cat "$holder_log" >&2
  echo "--- create contender ---" >&2
  cat "$contender_log" >&2
  exit 1
fi

remaining="$(${psql_base[@]} -Atqc "select count(*) from public.happy_tenant_records where record_id = 'create-after-membership-revoke'")"
if [[ "$remaining" != "0" ]]; then
  echo "Create RPC wrote a record after membership revocation." >&2
  exit 1
fi

echo "PostgreSQL tenant membership-revocation serialization test: PASS"

