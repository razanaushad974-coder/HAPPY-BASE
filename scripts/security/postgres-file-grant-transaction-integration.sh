#!/usr/bin/env bash
set -euo pipefail

: "\${DATABASE_URL:?DATABASE_URL must point to a disposable PostgreSQL database}"

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
SQL

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/drafts/20261119_file_mutation_atomic_consume_candidate.sql

ORG='00000000-0000-0000-0000-000000000001'
WS='00000000-0000-0000-0000-000000000011'
REQUESTER='00000000-0000-0000-0000-000000000101'
EXECUTOR='00000000-0000-0000-0000-000000000102'
APPROVER='00000000-0000-0000-0000-000000000103'
DIGEST='aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa'

seed_grant() {
  local grant="$1" request="$2" approver_status="\${3:-ACTIVE}" approver_role="\${4:-ADMIN}" executor_status="\${5:-ACTIVE}" expiry="\${6:-5 minutes}"
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
 ('$ORG','$WS','$EXECUTOR','ACTIVE','MEMBER')
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
  'APPROVED',clock_timestamp()+interval '$expiry',clock_timestamp())
ON CONFLICT (grant_id) DO NOTHING;
SQL
}

invoke_grant() {
  local grant="$1" request="$2" user="$3" digest="\${4:-$DIGEST}"
  psql "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "
    BEGIN;
    SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claim.sub = '$user';
    SELECT public.consume_file_mutation_approval_grant(
      '$grant','$ORG','$WS','$request','task-$request','mission-$request',
      'file-$request','MODIFY','source-$request',NULL,'$digest'
    );
    COMMIT;" | grep -E '^(t|f)$' | tail -n 1
}

expect_result() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: $label expected=$expected actual=$actual" >&2
    exit 1
  fi
}

seed_grant '10000000-0000-0000-0000-000000000001' 'valid-1'
actual="$(invoke_grant '10000000-0000-0000-0000-000000000001' 'valid-1' "$EXECUTOR")"
expect_result t "$actual" 'valid exact binding'
actual="$(invoke_grant '10000000-0000-0000-0000-000000000001' 'valid-1' "$EXECUTOR")"
expect_result f "$actual" 'replay'
audit_count="$(psql "$DATABASE_URL" -XqAt -c "SELECT count(*) FROM private.file_mutation_approval_events WHERE grant_id='10000000-0000-0000-0000-000000000001' AND event_type='CONSUMED';")"
expect_result 1 "$audit_count" 'exactly one audit event'

seed_grant '10000000-0000-0000-0000-000000000002' 'wrong-executor-1'
actual="$(invoke_grant '10000000-0000-0000-0000-000000000002' 'wrong-executor-1' "$APPROVER")"
expect_result f "$actual" 'wrong executor JWT'

seed_grant '10000000-0000-0000-0000-000000000003' 'digest-1'
actual="$(invoke_grant '10000000-0000-0000-0000-000000000003' 'digest-1' "$EXECUTOR" 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb')"
expect_result f "$actual" 'changed digest'
seed_grant '10000000-0000-0000-0000-000000000004' 'expired-1' 'ACTIVE' 'ADMIN' 'ACTIVE' '-1 second'
actual="$(invoke_grant '10000000-0000-0000-0000-000000000004' 'expired-1' "$EXECUTOR")"
expect_result f "$actual" 'expired grant'

seed_grant '10000000-0000-0000-0000-000000000005' 'revoked-approver-1' 'REVOKED'
actual="$(invoke_grant '10000000-0000-0000-0000-000000000005' 'revoked-approver-1' "$EXECUTOR")"
expect_result f "$actual" 'revoked approver membership'
seed_grant '10000000-0000-0000-0000-000000000006' 'demoted-approver-1' 'ACTIVE' 'MEMBER'
actual="$(invoke_grant '10000000-0000-0000-0000-000000000006' 'demoted-approver-1' "$EXECUTOR")"
expect_result f "$actual" 'demoted approver role'

seed_grant '10000000-0000-0000-0000-000000000007' 'revoked-executor-1' 'ACTIVE' 'ADMIN' 'REVOKED'
actual="$(invoke_grant '10000000-0000-0000-0000-000000000007' 'revoked-executor-1' "$EXECUTOR")"
expect_result f "$actual" 'revoked executor membership'

seed_grant '10000000-0000-0000-0000-000000000008' 'concurrent-1'
invoke_grant '10000000-0000-0000-0000-000000000008' 'concurrent-1' "$EXECUTOR" > /tmp/happy-txn-consume-a.out & p1=$!
invoke_grant '10000000-0000-0000-0000-000000000008' 'concurrent-1' "$EXECUTOR" > /tmp/happy-txn-consume-b.out & p2=$!
wait "$p1"; wait "$p2"
winners="$(cat /tmp/happy-txn-consume-a.out /tmp/happy-txn-consume-b.out | grep -c '^t$' || true)"
expect_result 1 "$winners" 'concurrent consume winner count'
audit_count="$(psql "$DATABASE_URL" -XqAt -c "SELECT count(*) FROM private.file_mutation_approval_events WHERE grant_id='10000000-0000-0000-0000-000000000008';")"
expect_result 1 "$audit_count" 'concurrent audit count'

seed_grant '10000000-0000-0000-0000-000000000009' 'revoke-race-1'
psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c "
 BEGIN;
 UPDATE private.organization_memberships SET status='REVOKED'
 WHERE organization_id='$ORG' AND user_id='$APPROVER';
 SELECT pg_sleep(1.5);
 COMMIT;" &
revoke_pid=$!
sleep 0.2
actual="$(invoke_grant '10000000-0000-0000-0000-000000000009' 'revoke-race-1' "$EXECUTOR")"
wait "$revoke_pid"
expect_result f "$actual" 'revocation commits before consume'
audit_count="$(psql "$DATABASE_URL" -XqAt -c "SELECT count(*) FROM private.file_mutation_approval_events WHERE grant_id='10000000-0000-0000-0000-000000000009';")"
expect_result 0 "$audit_count" 'no audit on denied consume'

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

echo "PASS: migration-candidate RPC; JWT-derived executor; distinct principals; exact binding; expiry/replay; live approver/executor membership and role checks; one audit; concurrent single winner; revoke-vs-consume serialization; anon invocation denial."
