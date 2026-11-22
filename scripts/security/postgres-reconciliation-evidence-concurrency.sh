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
  psql "${psql_base[@]:1}" -c "drop trigger if exists happy_test_reconciliation_insert_delay on public.happy_dispatch_reconciliation_evidence; drop function if exists public.happy_test_reconciliation_insert_delay();" >/dev/null 2>&1 || true
}
trap cleanup EXIT

# Resolve the internal outbox ID as the disposable database owner. The
# worker-gated reconciliation RPC has no application-role EXECUTE grants;
# concurrency tests below therefore exercise its SQL state machine as the
# isolated database owner. Separate integration assertions verify that
# authenticated/anon/service_role cannot invoke the RPC.
outbox_id="$("${psql_base[@]}" -Atqc "select outbox_id from public.happy_execution_dispatch_outbox where execution_request_id='request-scheduler-2'")"
if [[ -z "$outbox_id" ]]; then
  echo "Expected scheduler outbox row was not found for reconciliation concurrency tests." >&2
  exit 1
fi

# A test-only BEFORE INSERT delay makes both transactions reach the unique
# evidence identity concurrently. The production SQL candidate is untouched.
"${psql_base[@]}" <<'SQL'
create or replace function public.happy_test_reconciliation_insert_delay()
returns trigger
language plpgsql
as $delay$
begin
  if new.evidence_id in (
    '90000000-0000-4000-8000-000000000011'::uuid,
    '90000000-0000-4000-8000-000000000012'::uuid
  ) then
    perform pg_sleep(2);
  end if;
  return new;
end;
$delay$;
create trigger happy_test_reconciliation_insert_delay
before insert on public.happy_dispatch_reconciliation_evidence
for each row execute function public.happy_test_reconciliation_insert_delay();
SQL

# Concurrent identical retries: both callers must succeed, but only one row
# may exist for the event identity.
PGAPPNAME=happy-reconcile-identical-a "${psql_base[@]}" -v outbox_id="$outbox_id" >"$holder_log" 2>&1 <<'SQL' &
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false);
select public.happy_append_dispatch_reconciliation_evidence(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  :'outbox_id'::uuid,
  '90000000-0000-4000-8000-000000000011',
  'tenant-attempt-key-2','test-provider','PROCESSING',
  '2026-11-21T12:00:00Z','{"status":"PROCESSING","providerRequestId":"concurrent-identical"}'::jsonb
);
SQL
pid_a=$!
PGAPPNAME=happy-reconcile-identical-b "${psql_base[@]}" -v outbox_id="$outbox_id" >"$contender_log" 2>&1 <<'SQL' &
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false);
select public.happy_append_dispatch_reconciliation_evidence(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  :'outbox_id'::uuid,
  '90000000-0000-4000-8000-000000000011',
  'tenant-attempt-key-2','test-provider','PROCESSING',
  '2026-11-21T12:00:00Z','{"status":"PROCESSING","providerRequestId":"concurrent-identical"}'::jsonb
);
SQL
pid_b=$!

both_sleeping=false
for _ in $(seq 1 200); do
  sleeping="$("${psql_base[@]}" -Atqc "select count(*) from pg_stat_activity where application_name in ('happy-reconcile-identical-a','happy-reconcile-identical-b') and state='active' and wait_event='PgSleep'")"
  if [[ "$sleeping" == "2" ]]; then both_sleeping=true; break; fi
  sleep 0.05
done
if [[ "$both_sleeping" != "true" ]]; then
  kill "$pid_a" "$pid_b" 2>/dev/null || true
  echo "Concurrent identical evidence calls did not overlap in the insert trigger." >&2
  cat "$holder_log" "$contender_log" >&2
  exit 1
fi
set +e
wait "$pid_a"; status_a=$?
wait "$pid_b"; status_b=$?
set -e
if [[ "$status_a" -ne 0 || "$status_b" -ne 0 ]]; then
  echo "Concurrent identical evidence retries must both succeed." >&2
  cat "$holder_log" "$contender_log" >&2
  exit 1
fi
identical_count="$("${psql_base[@]}" -Atqc "select count(*) from public.happy_dispatch_reconciliation_evidence where evidence_id='90000000-0000-4000-8000-000000000011'")"
if [[ "$identical_count" != "1" ]]; then
  echo "Concurrent identical evidence retries created $identical_count rows, expected 1." >&2
  exit 1
fi

: >"$holder_log"
: >"$contender_log"
# Concurrent conflicting payloads reuse one event UUID. Exactly one insert
# wins; the other must receive the RPC's 23505 identity-reuse rejection.
PGAPPNAME=happy-reconcile-conflict-a "${psql_base[@]}" -v outbox_id="$outbox_id" -v VERBOSITY=verbose >"$holder_log" 2>&1 <<'SQL' &
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false);
select public.happy_append_dispatch_reconciliation_evidence(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  :'outbox_id'::uuid,
  '90000000-0000-4000-8000-000000000012',
  'tenant-attempt-key-2','test-provider','PROCESSING',
  '2026-11-21T12:01:00Z','{"status":"PROCESSING","providerRequestId":"conflict-a"}'::jsonb
);
SQL
pid_a=$!
PGAPPNAME=happy-reconcile-conflict-b "${psql_base[@]}" -v outbox_id="$outbox_id" -v VERBOSITY=verbose >"$contender_log" 2>&1 <<'SQL' &
select set_config('request.jwt.claim.sub','30000000-0000-4000-8000-000000000003',false);
select public.happy_append_dispatch_reconciliation_evidence(
  '10000000-0000-4000-8000-000000000001',
  '20000000-0000-4000-8000-000000000002',
  :'outbox_id'::uuid,
  '90000000-0000-4000-8000-000000000012',
  'tenant-attempt-key-2','test-provider','SUCCEEDED',
  '2026-11-21T12:01:00Z','{"status":"SUCCEEDED","providerRequestId":"conflict-b"}'::jsonb
);
SQL
pid_b=$!
both_sleeping=false
for _ in $(seq 1 200); do
  sleeping="$("${psql_base[@]}" -Atqc "select count(*) from pg_stat_activity where application_name in ('happy-reconcile-conflict-a','happy-reconcile-conflict-b') and state='active' and wait_event='PgSleep'")"
  if [[ "$sleeping" == "2" ]]; then both_sleeping=true; break; fi
  sleep 0.05
done
if [[ "$both_sleeping" != "true" ]]; then
  kill "$pid_a" "$pid_b" 2>/dev/null || true
  echo "Concurrent conflicting evidence calls did not overlap in the insert trigger." >&2
  cat "$holder_log" "$contender_log" >&2
  exit 1
fi
set +e
wait "$pid_a"; status_a=$?
wait "$pid_b"; status_b=$?
set -e
if ! { [[ "$status_a" -eq 0 && "$status_b" -ne 0 ]] || [[ "$status_a" -ne 0 && "$status_b" -eq 0 ]]; }; then
  echo "Conflicting concurrent event-ID reuse must produce exactly one winner." >&2
  cat "$holder_log" "$contender_log" >&2
  exit 1
fi
if ! grep -q '23505' "$holder_log" "$contender_log"; then
  echo "Losing conflicting event-ID reuse did not return SQLSTATE 23505." >&2
  cat "$holder_log" "$contender_log" >&2
  exit 1
fi
conflict_count="$("${psql_base[@]}" -Atqc "select count(*) from public.happy_dispatch_reconciliation_evidence where evidence_id='90000000-0000-4000-8000-000000000012'")"
if [[ "$conflict_count" != "1" ]]; then
  echo "Conflicting concurrent evidence calls created $conflict_count rows, expected 1." >&2
  exit 1
fi

echo "PostgreSQL concurrent reconciliation evidence append/idempotency test: PASS"
