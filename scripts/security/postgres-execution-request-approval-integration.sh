#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must point to a disposable PostgreSQL database}"

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname='service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;
DROP SCHEMA IF EXISTS private CASCADE;
DROP SCHEMA IF EXISTS auth CASCADE;
DROP SCHEMA IF EXISTS extensions CASCADE;
CREATE SCHEMA auth;
CREATE SCHEMA extensions;
CREATE TABLE auth.users (id uuid primary key);
CREATE FUNCTION auth.uid() RETURNS uuid
LANGUAGE sql STABLE
AS $$ SELECT nullif(current_setting('request.jwt.claim.sub', true), '')::uuid $$;
CREATE EXTENSION pgcrypto WITH SCHEMA extensions;
DROP FUNCTION IF EXISTS public.consume_file_mutation_approval_grant(uuid,uuid,uuid,text,text,text,text,text,text,text,text);
DROP FUNCTION IF EXISTS public.resolve_authenticated_execution_request(text);
DROP FUNCTION IF EXISTS public.create_authenticated_execution_request(text,text,text,uuid,uuid,text,text,jsonb,jsonb,text);
DROP FUNCTION IF EXISTS public.decide_authenticated_execution_request(text,text,text);
SQL

psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/drafts/20261119_file_mutation_atomic_consume_candidate.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/drafts/20261121_authenticated_execution_request_rpc_candidate.sql
psql "$DATABASE_URL" -X -v ON_ERROR_STOP=1 -f supabase/drafts/20261121_authenticated_execution_envelope_candidate.sql

ORG='00000000-0000-4000-8000-000000000001'
WS='00000000-0000-4000-8000-000000000011'
REQUESTER='00000000-0000-4000-8000-000000000101'
FOUNDER='00000000-0000-4000-8000-000000000102'
OTHER='00000000-0000-4000-8000-000000000103'

psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 <<SQL
INSERT INTO auth.users(id) VALUES ('$REQUESTER'),('$FOUNDER'),('$OTHER');
INSERT INTO private.organizations VALUES ('$ORG','ACTIVE');
INSERT INTO private.workspaces VALUES ('$WS','$ORG','ACTIVE');
INSERT INTO private.organization_memberships VALUES
 ('$ORG','$REQUESTER','ACTIVE','MEMBER'),
 ('$ORG','$FOUNDER','ACTIVE','FOUNDER'),
 ('$ORG','$OTHER','ACTIVE','MEMBER');
INSERT INTO private.workspace_memberships VALUES
 ('$ORG','$WS','$REQUESTER','ACTIVE','MEMBER'),
 ('$ORG','$WS','$FOUNDER','ACTIVE','OWNER'),
 ('$ORG','$WS','$OTHER','ACTIVE','MEMBER');
SQL

expect() {
  local expected="$1" actual="$2" label="$3"
  if [[ "$actual" != "$expected" ]]; then
    echo "FAIL: $label expected=$expected actual=$actual" >&2
    exit 1
  fi
}

create_request() {
  local user="$1" request="$2" idem="$3" action="${4:-READ}" input="${5:-{""path"":""README.md""}}"
  psql "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "
    BEGIN;
    SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claim.sub = '$user';
    SELECT status || ':' || risk || ':' || approval_status || ':' ||
           required_approval_role || ':' || requires_approval::text
      FROM public.create_authenticated_execution_request(
        '$request','task-$request','mission-$request','$ORG','$WS',
        'FILE','$action','$input'::jsonb,NULL,'$idem'
      );
    COMMIT;" | grep -E '^(WAITING_APPROVAL|READY):' | tail -n 1
}

resolve_request() {
  local user="$1" request="$2"
  psql "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "
    BEGIN;
    SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claim.sub = '$user';
    SELECT status || ':' || capability || ':' || action || ':' || risk || ':' ||
           approval_status || ':' || required_approval_role
      FROM public.resolve_authenticated_execution_request('$request');
    COMMIT;" | grep -E '^(WAITING_APPROVAL|READY|CANCELLED):' | tail -n 1 || true
}

decide_request() {
  local user="$1" request="$2" decision="$3"
  psql "$DATABASE_URL" -XqAt -v ON_ERROR_STOP=1 -c "
    BEGIN;
    SET LOCAL ROLE authenticated;
    SET LOCAL request.jwt.claim.sub = '$user';
    SELECT public.decide_authenticated_execution_request('$request','$decision','Reviewed by founder');
    COMMIT;" | grep -E '^(t|f)$' | tail -n 1
}

actual="$(create_request "$REQUESTER" 'req-approve-1' 'idem-approve-1')"
expect 'WAITING_APPROVAL:HIGH:PENDING:FOUNDER:true' "$actual" 'database-forced founder approval'
actual="$(resolve_request "$REQUESTER" 'req-approve-1')"
expect 'WAITING_APPROVAL:FILE:READ:HIGH:PENDING:FOUNDER' "$actual" 'executor receives full immutable envelope'
actual="$(resolve_request "$OTHER" 'req-approve-1')"
expect '' "$actual" 'non-executor cannot resolve request'

# Same idempotency key and identical immutable intent returns the original row.
actual="$(create_request "$REQUESTER" 'req-approve-1' 'idem-approve-1')"
expect 'WAITING_APPROVAL:HIGH:PENDING:FOUNDER:true' "$actual" 'idempotent request retry'

# Reusing the idempotency key for a different request/input must fail closed.
if create_request "$REQUESTER" 'req-conflict' 'idem-approve-1' 'DELETE' '{"path":"secrets.txt"}' >/dev/null 2>&1; then
  echo "FAIL: idempotency key accepted different execution intent" >&2
  exit 1
fi

# Requester cannot approve their own request, and a non-founder cannot approve.
actual="$(decide_request "$REQUESTER" 'req-approve-1' 'APPROVED')"
expect f "$actual" 'requester cannot self-approve'
actual="$(decide_request "$OTHER" 'req-approve-1' 'APPROVED')"
expect f "$actual" 'non-founder cannot approve'
actual="$(decide_request "$FOUNDER" 'req-approve-1' 'APPROVED')"
expect t "$actual" 'active founder approves exact request'
actual="$(resolve_request "$REQUESTER" 'req-approve-1')"
expect 'READY:FILE:READ:HIGH:APPROVED:FOUNDER' "$actual" 'approved request moves to READY'
actual="$(decide_request "$FOUNDER" 'req-approve-1' 'APPROVED')"
expect f "$actual" 'approval decision cannot be replayed'

actual="$(create_request "$REQUESTER" 'req-reject-1' 'idem-reject-1')"
expect 'WAITING_APPROVAL:HIGH:PENDING:FOUNDER:true' "$actual" 'second request awaits approval'
actual="$(decide_request "$FOUNDER" 'req-reject-1' 'REJECTED')"
expect t "$actual" 'founder rejects request'
actual="$(resolve_request "$REQUESTER" 'req-reject-1')"
expect 'CANCELLED:FILE:READ:HIGH:REJECTED:FOUNDER' "$actual" 'rejected request is cancelled'

# A founder-created request cannot be approved by that same founder.
actual="$(create_request "$FOUNDER" 'req-self-1' 'idem-self-1')"
expect 'WAITING_APPROVAL:HIGH:PENDING:FOUNDER:true' "$actual" 'founder request awaits a different approver'
actual="$(decide_request "$FOUNDER" 'req-self-1' 'APPROVED')"
expect f "$actual" 'founder cannot self-approve'

# Membership revocation before the decision wins; the RPC denies approval.
actual="$(create_request "$REQUESTER" 'req-revoked-founder-1' 'idem-revoked-founder-1')"
expect 'WAITING_APPROVAL:HIGH:PENDING:FOUNDER:true' "$actual" 'revocation test request awaits approval'
psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c "
  UPDATE private.organization_memberships SET status='REVOKED'
   WHERE organization_id='$ORG' AND user_id='$FOUNDER';"
actual="$(decide_request "$FOUNDER" 'req-revoked-founder-1' 'APPROVED')"
expect f "$actual" 'revoked founder cannot approve'

# Even the service role cannot rewrite immutable execution intent; the trigger
# protects the envelope independently of table-level privilege.
if psql "$DATABASE_URL" -Xq -v ON_ERROR_STOP=1 -c "
  SET ROLE service_role;
  UPDATE private.execution_requests SET input='{""path"":""tampered""}'::jsonb
   WHERE request_id='req-approve-1';" >/dev/null 2>&1; then
  echo "FAIL: immutable execution envelope was rewritten" >&2
  exit 1
fi

echo "Authenticated execution request + founder approval PostgreSQL integration: PASS"
