#!/usr/bin/env bash
set -euo pipefail

: "${PGHOST:?PGHOST is required}"
: "${PGPORT:?PGPORT is required}"
: "${PGUSER:?PGUSER is required}"
: "${PGPASSWORD:?PGPASSWORD is required}"
: "${PGDATABASE:?PGDATABASE is required}"

export PGPASSWORD
psql_base=(psql -X -v ON_ERROR_STOP=1)
holder_log="$(mktemp)"
contender_log="$(mktemp)"
cleanup() {
  rm -f "$holder_log" "$contender_log"
}
trap cleanup EXIT

org_id='10000000-0000-4000-8000-000000000001'
workspace_id='20000000-0000-4000-8000-000000000002'
requester_id='30000000-0000-4000-8000-000000000003'
founder_id='40000000-0000-4000-8000-000000000004'

# Seed two valid pending requests. The requester is an active MEMBER and the
# approver is a separate active FOUNDER; the insert guard still enforces the
# immutable pending founder-approval envelope.
"${psql_base[@]}" <<SQL
insert into private.execution_requests(
  request_id,task_id,mission_id,requester_user_id,executor_user_id,
  organization_id,workspace_id,status,capability,action,input,target_reference,
  requires_approval,risk,approval_status,required_approval_role,
  input_digest,envelope_digest,idempotency_key
) values
  ('approval-race-revoke-first','task-race-a','mission-race-a',
   '$requester_id','$requester_id','$org_id','$workspace_id','WAITING_APPROVAL',
   'FILE','write-file','{}'::jsonb,null,true,'HIGH','PENDING','FOUNDER',
   repeat('a',64),repeat('b',64),'approval-race-revoke-first'),
  ('approval-race-decision-first','task-race-b','mission-race-b',
   '$requester_id','$requester_id','$org_id','$workspace_id','WAITING_APPROVAL',
   'FILE','write-file','{}'::jsonb,null,true,'HIGH','PENDING','FOUNDER',
   repeat('c',64),repeat('d',64),'approval-race-decision-first');
SQL

# Ordering A: membership revocation acquires the exact founder membership row
# first. The decision RPC must block on that row, then observe REVOKED and deny.
PGAPPNAME=happy-approval-revoke-first-holder "${psql_base[@]}" >"$holder_log" 2>&1 <<SQL &
begin;
select user_id from private.organization_memberships
 where organization_id='$org_id' and user_id='$founder_id' for update;
select pg_sleep(3);
update private.organization_memberships set status='REVOKED'
 where organization_id='$org_id' and user_id='$founder_id';
commit;
SQL
holder_pid=$!

holder_ready=false
for _ in $(seq 1 200); do
  if "${psql_base[@]}" -Atqc "select 1 from pg_stat_activity where application_name='happy-approval-revoke-first-holder' and state='active' and wait_event='PgSleep' limit 1" | grep -q '^1$'; then
    holder_ready=true
    break
  fi
  sleep 0.05
done
if [[ "$holder_ready" != "true" ]]; then
  kill "$holder_pid" 2>/dev/null || true
  echo "Founder-membership revocation holder did not reach its lock barrier." >&2
  cat "$holder_log" >&2
  exit 1
fi

PGAPPNAME=happy-approval-revoke-first-contender "${psql_base[@]}" -v VERBOSITY=verbose >"$contender_log" 2>&1 <<SQL &
set role authenticated;
select set_config('request.jwt.claim.sub','$founder_id',false);
select public.decide_authenticated_execution_request(
  'approval-race-revoke-first','APPROVED','race test'
);
SQL
contender_pid=$!

lock_seen=false
for _ in $(seq 1 200); do
  if "${psql_base[@]}" -Atqc "select 1 from pg_stat_activity where application_name='happy-approval-revoke-first-contender' and state='active' and wait_event_type='Lock' limit 1" | grep -q '^1$'; then
    lock_seen=true
    break
  fi
  sleep 0.05
done
if [[ "$lock_seen" != "true" ]]; then
  kill "$holder_pid" "$contender_pid" 2>/dev/null || true
  echo "Founder decision did not wait on the concurrent membership revocation." >&2
  cat "$holder_log" "$contender_log" >&2
  exit 1
fi

set +e
wait "$holder_pid"; holder_status=$?
wait "$contender_pid"; contender_status=$?
set -e
if [[ "$holder_status" -ne 0 || "$contender_status" -ne 0 ]] ||
   ! grep -Eq '(^|[[:space:]])f([[:space:]]|$)' "$contender_log"; then
  echo "Revocation-first race must commit revocation and deny approval (false)." >&2
  cat "$holder_log" "$contender_log" >&2
  exit 1
fi

"${psql_base[@]}" <<SQL
DO \$verify_revoke_first\$
begin
  if (select status from private.organization_memberships
       where organization_id='$org_id' and user_id='$founder_id') <> 'REVOKED'
     or (select status from private.execution_requests
       where request_id='approval-race-revoke-first') <> 'WAITING_APPROVAL'
     or exists (select 1 from private.execution_request_approval_events
       where request_id='approval-race-revoke-first') then
    raise exception 'revocation-first serialization produced an approval or inconsistent state';
  end if;
end
\$verify_revoke_first\$;
update private.organization_memberships set status='ACTIVE'
 where organization_id='$org_id' and user_id='$founder_id';
SQL

# Ordering B: the real decision RPC locks the founder membership and commits
# the approval while deliberately holding its transaction open. A concurrent
# revocation must wait; after approval commits, revocation may then complete.
PGAPPNAME=happy-approval-decision-first-holder "${psql_base[@]}" >"$holder_log" 2>&1 <<SQL &
begin;
set local role authenticated;
select set_config('request.jwt.claim.sub','$founder_id',true);
select public.decide_authenticated_execution_request(
  'approval-race-decision-first','APPROVED','race test'
);
select pg_sleep(3);
commit;
SQL
holder_pid=$!

decision_ready=false
for _ in $(seq 1 200); do
  if "${psql_base[@]}" -Atqc "select 1 from pg_stat_activity where application_name='happy-approval-decision-first-holder' and state='active' and wait_event='PgSleep' limit 1" | grep -q '^1$'; then
    decision_ready=true
    break
  fi
  sleep 0.05
done
if [[ "$decision_ready" != "true" ]]; then
  kill "$holder_pid" 2>/dev/null || true
  echo "Founder decision did not reach its post-decision lock barrier." >&2
  cat "$holder_log" >&2
  exit 1
fi

PGAPPNAME=happy-approval-decision-first-contender "${psql_base[@]}" >"$contender_log" 2>&1 <<SQL &
update private.organization_memberships set status='REVOKED'
 where organization_id='$org_id' and user_id='$founder_id';
SQL
contender_pid=$!

revoke_wait_seen=false
for _ in $(seq 1 200); do
  if "${psql_base[@]}" -Atqc "select 1 from pg_stat_activity where application_name='happy-approval-decision-first-contender' and state='active' and wait_event_type='Lock' limit 1" | grep -q '^1$'; then
    revoke_wait_seen=true
    break
  fi
  sleep 0.05
done
if [[ "$revoke_wait_seen" != "true" ]]; then
  kill "$holder_pid" "$contender_pid" 2>/dev/null || true
  echo "Membership revocation did not wait behind the in-flight founder decision." >&2
  cat "$holder_log" "$contender_log" >&2
  exit 1
fi

set +e
wait "$holder_pid"; holder_status=$?
wait "$contender_pid"; contender_status=$?
set -e
if [[ "$holder_status" -ne 0 || "$contender_status" -ne 0 ]] ||
   ! grep -Eq '(^|[[:space:]])t([[:space:]]|$)' "$holder_log"; then
  echo "Decision-first race must commit approval before membership revocation." >&2
  cat "$holder_log" "$contender_log" >&2
  exit 1
fi

"${psql_base[@]}" <<SQL
DO \$verify_decision_first\$
begin
  if (select status from private.organization_memberships
       where organization_id='$org_id' and user_id='$founder_id') <> 'REVOKED'
     or (select status from private.execution_requests
       where request_id='approval-race-decision-first') <> 'READY'
     or not exists (select 1 from private.execution_request_approval_events
       where request_id='approval-race-decision-first'
         and actor_user_id='$founder_id' and decision='APPROVED') then
    raise exception 'decision-first serialization did not preserve committed approval then revocation';
  end if;
end
\$verify_decision_first\$;
SQL

echo "PostgreSQL concurrent founder-approval/membership-revocation serialization: PASS"
