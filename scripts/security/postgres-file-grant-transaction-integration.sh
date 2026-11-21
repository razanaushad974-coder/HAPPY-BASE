#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must point to a disposable PostgreSQL database}"

# Emulates the Supabase auth schema contract. PostgREST sets this claim only
# after JWT verification; this fixture does not prove an external JWT verifier.
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
DROP SCHEMA IF EXISTS private CASCADE;
DROP SCHEMA IF EXISTS auth CASCADE;
CREATE SCHEMA auth;
CREATE TABLE auth.users (id uuid primary key);
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
DROP FUNCTION IF EXISTS public.consume_file_mutation_approval_grant(uuid,uuid,uuid,text,text,text,text,text,text,text,text);
DROP FUNCTION IF EXISTS public.resolve_authenticated_file_mutation_approval_grant(uuid,uuid,text,text,text,uuid,text,text,text,text,text);
DROP FUNCTION IF EXISTS public.resolve_authenticated_file_mutation_approver_membership(uuid,uuid,uuid);
SQL

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/drafts/20261119_file_mutation_atomic_consume_candidate.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/drafts/20261121_authenticated_file_mutation_grant_lookup_rpc_candidate.sql

ORG='00000000-0000-0000-0000-000000000001'
WS='00000000-0000-0000-0000-000000000011'
REQUESTER='00000000-0000-0000-0000-000000000101'
EXECUTOR='00000000-0000-0000-0000-000000000102'
APPROVER='00000000-0000-0000-0000-000000000103'
DIGEST='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

seed_grant() {
  local grant="$1" request="$2" approver_status="${3:-ACTIVE}" approver_role="${4:-ADMIN}" executor_status="${5:-ACTIVE}" expiry="${6:-5 minutes}"
  psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 <<SQL
INSERT INTO auth.users(id) VALUES
 ('$REQUESTER'),('$EXECUTOR'),('$APPROVER')
ON CONFLICT DO NOTHING;
INSERT INTO private.organizations VALUES ('$ORG','ACTIVE')
ON CONFLICT (organization_id) DO UPDATE SET status='ACTIVE';
INSERT INTO private.workspaces VALUES ('$WS','$ORG','ACTIVE')
ON CONFLICT (workspace_id) DO UPDATE SET status='ACTIVE';
INSERT INTO private.organization_memberships VALUES
 ('$ORG','$EXECUTOR','$executor_status','MEMBER'),
 ('$ORG','$APPROVER','$approver_status','$approver_role')
ON CONFLICT (organization_id,user_id) DO UPDATE
 SET status=excluded.status, role=excluded.role;
INSERT INTO private.workspace_memberships VALUES
 ('$ORG','$WS','$EXECUTOR','ACTIVE','MEMBER'),
 ('$ORG','$WS','$APPROVER','ACTIVE','MEMBER')
ON CONFLICT (organization_id,workspace_id,user_id) DO UPDATE SET status='ACTIVE';
INSERT INTO private.execution_requests
 (request_id,task_id,mission_id,requester_user_id,executor_user_id,organization_id,workspace_id,status)
 VALUES ('$request','task-$request','mission-$request','$REQUESTER','$EXECUTOR','$ORG','$WS','READY')
ON CONFLICT (request_id) DO UPDATE SET status='READY';
INSERT INTO private.file_mutation_approval_grants
 (grant_id,request_id,task_id,mission_id,requester_user_id,executor_user_id,approver_user_id,
  organization_id,workspace_id,target_entity_type,target_entity_id,operation,source_path,
  destination_path,input_digest,required_role,status,expires_at,decided_at)
 VALUES ('$grant','$request','task-$request','mission-$request','$REQUESTER','$EXECUTOR','$APPROVER',
  '$ORG','$WS','FILE','file-$request','MODIFY','source-$request',NULL,'$DIGEST','ADMIN',
  'PENDING',clock_timestamp()+interval '$expiry',NULL)
ON CONFLICT (grant_id) DO NOTHING;
UPDATE private.file_mutation_approval_grants
   SET status='APPROVED', decided_at=clock_timestamp()
 WHERE grant_id='$grant' AND status='PENDING';
SQL
}

lookup_grant() {
  local request="$1" user="$2" digest="${3:-$DIGEST}"
  psql "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "
    BEGIN;
    SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claim.sub = '$user';
    SELECT count(*)::text || ':' || coalesce(max(grant_id::text), '')
      FROM public.resolve_authenticated_file_mutation_approval_grant(
        '$ORG','$WS','$request','task-$request','mission-$request','$REQUESTER',
        'file-$request','MODIFY','source-$request',NULL,'$digest'
      );
    COMMIT;" | grep -E '^[0-9]+:' | tail -n 1
}

lookup_approver() {
  local grant="$1" user="$2"
  psql "$DATABASE_URL" -XqAt -F ':' -v ON_ERROR_STOP=1 -c "
    BEGIN;
    SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claim.sub = '$user';
    SELECT approver_user_id::text || ':' || organization_role || ':' || workspace_role
      FROM public.resolve_authenticated_file_mutation_approver_membership(
        '$grant','$ORG','$WS'
      );
    COMMIT;" | grep -E '^[0-9a-f-]+:' | tail -n 1
}
invoke_grant() {
  local grant="$1" request="$2" user="$3" digest="${4:-$DIGEST}" application_name="${5:-happy-file-grant-consumer}"
  PGAPPNAME="$application_name" psql "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "
    BEGIN;
    SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claim.sub = '$user';
    SELECT public.consume_file_mutation_approval_grant(
      '$grant','$ORG','$WS','$request','task-$request','mission-$request',
      'file-$request','MODIFY','source-$request',NULL,'$digest'
    );
    COMMIT;" | grep -E '^(t|f)$' | tail -n 1
}



wait_for_lock_holder_sleep() {
  local application_name="$1"
  local attempt sleeping
  for attempt in $(seq 1 200); do
    sleeping="$(psql "$DATABASE_URL" -XqAt -c "SELECT count(*) FROM pg_stat_activity WHERE application_name='$application_name' AND state='active' AND wait_event='PgSleep';")"
    if [[ "$sleeping" -gt 0 ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "FAIL: timed out waiting for PostgreSQL lock holder to acquire lock: $application_name" >&2
  return 1
}

wait_for_lock_wait() {
  local application_name="$1"
  local attempt waiting
  for attempt in $(seq 1 200); do
    waiting="$(psql "$DATABASE_URL" -XqAt -c "SELECT count(*) FROM pg_stat_activity WHERE application_name='$application_name' AND wait_event_type='Lock';")"
    if [[ "$waiting" -gt 0 ]]; then
      return 0
    fi
    sleep 0.05
  done
  echo "FAIL: timed out waiting for PostgreSQL lock waiter: $application_name" >&2
  return 1
}

expect_result() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: $label expected=$expected actual=$actual" >&2
    exit 1
  fi
}

seed_grant '10000000-0000-0000-0000-000000000001' 'valid-1'
actual="$(lookup_grant 'valid-1' "$EXECUTOR")"
expect_result '1:10000000-0000-0000-0000-000000000001' "$actual" 'executor-bound exact grant lookup'
actual="$(lookup_approver '10000000-0000-0000-0000-000000000001' "$EXECUTOR")"
expect_result "$APPROVER:ADMIN:MEMBER" "$actual" 'executor-bound persisted approver membership lookup'
actual="$(lookup_approver '10000000-0000-0000-0000-000000000001' "$APPROVER")"
expect_result '' "$actual" 'approver cannot self-assert as executor'
actual="$(lookup_approver '10000000-0000-0000-0000-000000000001' "$REQUESTER")"
expect_result '' "$actual" 'requester cannot inspect approver membership'
actual="$(lookup_grant 'valid-1' "$APPROVER")"
expect_result '0:' "$actual" 'grant lookup by non-executor'
actual="$(lookup_grant 'valid-1' "$EXECUTOR" 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')"
expect_result '0:' "$actual" 'grant lookup changed digest'
actual="$(invoke_grant '10000000-0000-0000-0000-000000000001' 'valid-1' "$EXECUTOR")"
expect_result t "$actual" 'valid exact binding'
actual="$(lookup_grant 'valid-1' "$EXECUTOR")"
expect_result '0:' "$actual" 'consumed grant no longer discoverable'
actual="$(invoke_grant '10000000-0000-0000-0000-000000000001' 'valid-1' "$EXECUTOR")"
expect_result f "$actual" 'replay'
audit_count="$(psql "$DATABASE_URL" -XqAt -c "SELECT count(*) FROM private.file_mutation_approval_events WHERE grant_id='10000000-0000-0000-0000-000000000001' AND event_type='CONSUMED';")"
expect_result 1 "$audit_count" 'exactly one audit event'

# The service role may create pending grants but cannot bypass the approval RPC
# to update a grant or rewrite its append-only audit history.
if psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c "
 SET ROLE service_role;
 UPDATE private.file_mutation_approval_grants
 SET status='REVOKED'
 WHERE grant_id='10000000-0000-0000-0000-000000000001';" >/dev/null 2>&1; then
  echo "FAIL: service_role directly updated a grant" >&2
  exit 1
fi
if psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c "
 SET ROLE service_role;
 UPDATE private.file_mutation_approval_events
 SET event_type='CONSUMED'
 WHERE grant_id='10000000-0000-0000-0000-000000000001';" >/dev/null 2>&1; then
  echo "FAIL: service_role rewrote an audit event" >&2
  exit 1
fi

seed_grant '10000000-0000-0000-0000-000000000002' 'wrong-executor-1'
actual="$(invoke_grant '10000000-0000-0000-0000-000000000002' 'wrong-executor-1' "$APPROVER")"
expect_result f "$actual" 'wrong executor JWT'

seed_grant '10000000-0000-0000-0000-000000000003' 'digest-1'
actual="$(invoke_grant '10000000-0000-0000-0000-000000000003' 'digest-1' "$EXECUTOR" 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')"
expect_result f "$actual" 'changed digest'
seed_grant '10000000-0000-0000-0000-000000000004' 'expired-1' 'ACTIVE' 'ADMIN' 'ACTIVE' '-1 second'
actual="$(invoke_grant '10000000-0000-0000-0000-000000000004' 'expired-1' "$EXECUTOR")"
expect_result f "$actual" 'expired grant'

seed_grant '10000000-0000-0000-0000-000000000020' 'approver-revoked-lookup-1' 'REVOKED'
actual="$(lookup_approver '10000000-0000-0000-0000-000000000020' "$EXECUTOR")"
expect_result '' "$actual" 'revoked approver hidden from executor-JWT lookup'

seed_grant '10000000-0000-0000-0000-000000000021' 'approver-role-downgrade-lookup-1' 'ACTIVE' 'MEMBER'
actual="$(lookup_approver '10000000-0000-0000-0000-000000000021' "$EXECUTOR")"
expect_result '' "$actual" 'approver role downgrade hidden from executor-JWT lookup'

seed_grant '10000000-0000-0000-0000-000000000005' 'revoked-approver-1' 'REVOKED'
actual="$(invoke_grant '10000000-0000-0000-0000-000000000005' 'revoked-approver-1' "$EXECUTOR")"
expect_result f "$actual" 'revoked approver membership'
seed_grant '10000000-0000-0000-0000-000000000006' 'demoted-approver-1' 'ACTIVE' 'MEMBER'
actual="$(invoke_grant '10000000-0000-0000-0000-000000000006' 'demoted-approver-1' "$EXECUTOR")"
expect_result f "$actual" 'demoted approver role'

seed_grant '10000000-0000-0000-0000-000000000007' 'revoked-executor-1' 'ACTIVE' 'ADMIN' 'REVOKED'
actual="$(invoke_grant '10000000-0000-0000-0000-000000000007' 'revoked-executor-1' "$EXECUTOR")"
expect_result f "$actual" 'revoked executor membership'

seed_grant '10000000-0000-0000-0000-000000000013' 'revoked-approver-workspace-1'
psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c "
 UPDATE private.workspace_memberships SET status='REVOKED'
 WHERE organization_id='$ORG' AND workspace_id='$WS' AND user_id='$APPROVER';"
actual="$(invoke_grant '10000000-0000-0000-0000-000000000013' 'revoked-approver-workspace-1' "$EXECUTOR")"
expect_result f "$actual" 'revoked approver workspace membership'

seed_grant '10000000-0000-0000-0000-000000000008' 'concurrent-1'
invoke_grant '10000000-0000-0000-0000-000000000008' 'concurrent-1' "$EXECUTOR" > /tmp/happy-txn-consume-a.out & p1=$!
invoke_grant '10000000-0000-0000-0000-000000000008' 'concurrent-1' "$EXECUTOR" > /tmp/happy-txn-consume-b.out & p2=$!
wait "$p1"; wait "$p2"
winners="$(cat /tmp/happy-txn-consume-a.out /tmp/happy-txn-consume-b.out | grep -c '^t$' || true)"
expect_result 1 "$winners" 'concurrent consume winner count'
audit_count="$(psql "$DATABASE_URL" -XqAt -c "SELECT count(*) FROM private.file_mutation_approval_events WHERE grant_id='10000000-0000-0000-0000-000000000008';")"
expect_result 1 "$audit_count" 'concurrent audit count'

seed_grant '10000000-0000-0000-0000-000000000009' 'revoke-race-1'
PGAPPNAME=happy-revoke-lock-holder psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c "
 BEGIN;
 UPDATE private.organization_memberships SET status='REVOKED'
 WHERE organization_id='$ORG' AND user_id='$APPROVER';
 SELECT pg_sleep(15);
 COMMIT;" &
revoke_pid=$!
wait_for_lock_holder_sleep happy-revoke-lock-holder
invoke_grant '10000000-0000-0000-0000-000000000009' 'revoke-race-1' "$EXECUTOR" "$DIGEST" 'happy-revoke-consumer' > /tmp/happy-revoke-consumer.out &
revoke_consumer_pid=$!
wait_for_lock_wait happy-revoke-consumer
wait "$revoke_pid"
wait "$revoke_consumer_pid"
actual="$(cat /tmp/happy-revoke-consumer.out | tail -n 1)"
expect_result f "$actual" 'revocation commits before consume'
audit_count="$(psql "$DATABASE_URL" -XqAt -c "SELECT count(*) FROM private.file_mutation_approval_events WHERE grant_id='10000000-0000-0000-0000-000000000009';")"
expect_result 0 "$audit_count" 'no audit on denied consume'

seed_grant '10000000-0000-0000-0000-000000000011' 'role-downgrade-race-1'
PGAPPNAME=happy-downgrade-lock-holder psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c "
 BEGIN;
 UPDATE private.organization_memberships SET role='MEMBER'
 WHERE organization_id='$ORG' AND user_id='$APPROVER';
 SELECT pg_sleep(15);
 COMMIT;" &
downgrade_pid=$!
wait_for_lock_holder_sleep happy-downgrade-lock-holder
invoke_grant '10000000-0000-0000-0000-000000000011' 'role-downgrade-race-1' "$EXECUTOR" "$DIGEST" 'happy-downgrade-consumer' > /tmp/happy-downgrade-consumer.out &
downgrade_consumer_pid=$!
wait_for_lock_wait happy-downgrade-consumer
wait "$downgrade_pid"
wait "$downgrade_consumer_pid"
actual="$(cat /tmp/happy-downgrade-consumer.out | tail -n 1)"
expect_result f "$actual" 'role downgrade commits before consume'
audit_count="$(psql "$DATABASE_URL" -XqAt -c "SELECT count(*) FROM private.file_mutation_approval_events WHERE grant_id='10000000-0000-0000-0000-000000000011';")"
expect_result 0 "$audit_count" 'no audit on role-downgrade denied consume'

seed_grant '10000000-0000-0000-0000-000000000012' 'null-binding-1'
actual="$(psql "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "
 BEGIN;
 SET LOCAL ROLE authenticated;
 SET LOCAL request.jwt.claim.sub = '$EXECUTOR';
 SELECT public.consume_file_mutation_approval_grant(
  '10000000-0000-0000-0000-000000000012','$ORG','$WS',
  'null-binding-1','task-null-binding-1','mission-null-binding-1',
  NULL,'MODIFY','source-null-binding-1',NULL,'$DIGEST'
 );
 COMMIT;" | grep -E '^(t|f)$' | tail -n 1)"
expect_result f "$actual" 'NULL target binding'

seed_grant '10000000-0000-0000-0000-000000000010' 'consume-before-revoke-1'
actual="$(invoke_grant '10000000-0000-0000-0000-000000000010' 'consume-before-revoke-1' "$EXECUTOR")"
expect_result t "$actual" 'consume before later revocation'
psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c "
 UPDATE private.organization_memberships SET status='REVOKED'
 WHERE organization_id='$ORG' AND user_id='$APPROVER';"

if psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c "
 SET ROLE anon;
 SELECT public.consume_file_mutation_approval_grant(
  '10000000-0000-0000-0000-000000000010','$ORG','$WS',
  'consume-before-revoke-1','task-consume-before-revoke-1','mission-consume-before-revoke-1',
  'file-consume-before-revoke-1','MODIFY','source-consume-before-revoke-1',NULL,'$DIGEST'
 );" >/dev/null 2>&1; then
  echo "FAIL: anon role invoked privileged consume RPC" >&2
  exit 1
fi


# Tenant suspension and request cancellation must serialize as hard denials.
seed_grant '10000000-0000-0000-0000-000000000014' 'suspended-org-1'
psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c "
 UPDATE private.organizations SET status='SUSPENDED'
 WHERE organization_id='$ORG';"
actual="$(invoke_grant '10000000-0000-0000-0000-000000000014' 'suspended-org-1' "$EXECUTOR")"
expect_result f "$actual" 'suspended organization'

seed_grant '10000000-0000-0000-0000-000000000015' 'suspended-workspace-1'
psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c "
 UPDATE private.workspaces SET status='SUSPENDED'
 WHERE organization_id='$ORG' AND workspace_id='$WS';"
actual="$(invoke_grant '10000000-0000-0000-0000-000000000015' 'suspended-workspace-1' "$EXECUTOR")"
expect_result f "$actual" 'suspended workspace'

seed_grant '10000000-0000-0000-0000-000000000016' 'cancelled-request-1'
psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c "
 UPDATE private.execution_requests SET status='CANCELLED'
 WHERE request_id='cancelled-request-1';"
actual="$(invoke_grant '10000000-0000-0000-0000-000000000016' 'cancelled-request-1' "$EXECUTOR")"
expect_result f "$actual" 'cancelled execution request'


# Forced organization-suspension race: suspension commits first, consume denies.
seed_grant '10000000-0000-0000-0000-000000000017' 'suspend-first-1'
PGAPPNAME=happy-suspend-first-lock-holder psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c "
 BEGIN;
 UPDATE private.organizations SET status='SUSPENDED' WHERE organization_id='$ORG';
 SELECT pg_sleep(15);
 COMMIT;" &
suspend_first_pid=$!
wait_for_lock_holder_sleep happy-suspend-first-lock-holder
invoke_grant '10000000-0000-0000-0000-000000000017' 'suspend-first-1' "$EXECUTOR" "$DIGEST" 'happy-suspend-first-consumer' > /tmp/happy-suspend-first-consumer.out &
suspend_consumer_pid=$!
wait_for_lock_wait happy-suspend-first-consumer
wait "$suspend_first_pid"
wait "$suspend_consumer_pid"
actual="$(cat /tmp/happy-suspend-first-consumer.out | tail -n 1)"
expect_result f "$actual" 'organization suspension commits before consume'
audit_count="$(psql "$DATABASE_URL" -XqAt -c "SELECT count(*) FROM private.file_mutation_approval_events WHERE grant_id='10000000-0000-0000-0000-000000000017';")"
expect_result 0 "$audit_count" 'no audit after suspension-first race'

# Forced reverse order: consume commits first; later suspension cannot retroactively deny it.
seed_grant '10000000-0000-0000-0000-000000000018' 'consume-first-suspend-1'
PGAPPNAME=happy-consume-first-blocker psql "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "
 BEGIN;
 SET LOCAL ROLE authenticated;
 SET LOCAL request.jwt.claim.sub = '$EXECUTOR';
 SELECT public.consume_file_mutation_approval_grant(
  '10000000-0000-0000-0000-000000000018','$ORG','$WS',
  'consume-first-suspend-1','task-consume-first-suspend-1','mission-consume-first-suspend-1',
  'file-consume-first-suspend-1','MODIFY','source-consume-first-suspend-1',NULL,'$DIGEST'
 );
 SELECT pg_sleep(15);
 COMMIT;" > /tmp/happy-txn-consume-first-suspend.out &
consume_first_pid=$!
wait_for_lock_holder_sleep happy-consume-first-blocker
PGAPPNAME=happy-consume-first-suspender psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c "
 UPDATE private.organizations SET status='SUSPENDED' WHERE organization_id='$ORG';" &
suspender_pid=$!
wait_for_lock_wait happy-consume-first-suspender
wait "$consume_first_pid"
wait "$suspender_pid"
consume_first_result="$(grep -E '^(t|f)$' /tmp/happy-txn-consume-first-suspend.out | tail -n 1)"
expect_result t "$consume_first_result" 'consume commits before later suspension'
audit_count="$(psql "$DATABASE_URL" -XqAt -c "SELECT count(*) FROM private.file_mutation_approval_events WHERE grant_id='10000000-0000-0000-0000-000000000018' AND event_type='CONSUMED';")"
expect_result 1 "$audit_count" 'one audit after consume-first race'

# Forced request-cancellation race: cancellation commits first, consume denies.
seed_grant '10000000-0000-0000-0000-000000000019' 'cancel-first-1'
PGAPPNAME=happy-cancel-first-lock-holder psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c "
 BEGIN;
 UPDATE private.execution_requests SET status='CANCELLED' WHERE request_id='cancel-first-1';
 SELECT pg_sleep(15);
 COMMIT;" &
cancel_first_pid=$!
wait_for_lock_holder_sleep happy-cancel-first-lock-holder
invoke_grant '10000000-0000-0000-0000-000000000019' 'cancel-first-1' "$EXECUTOR" "$DIGEST" 'happy-cancel-first-consumer' > /tmp/happy-cancel-first-consumer.out &
cancel_consumer_pid=$!
wait_for_lock_wait happy-cancel-first-consumer
wait "$cancel_first_pid"
wait "$cancel_consumer_pid"
actual="$(cat /tmp/happy-cancel-first-consumer.out | tail -n 1)"
expect_result f "$actual" 'request cancellation commits before consume'
audit_count="$(psql "$DATABASE_URL" -XqAt -c "SELECT count(*) FROM private.file_mutation_approval_events WHERE grant_id='10000000-0000-0000-0000-000000000019';")"
expect_result 0 "$audit_count" 'no audit after cancellation-first race'

echo "PASS: migration-candidate RPC; JWT-derived executor; grant-bound approver membership lookup; distinct principals; exact binding; expiry/replay; live approver/executor membership and role checks; one audit; concurrent single winner; revoke-vs-consume serialization; organization suspension and request cancellation races; anon invocation denial."
