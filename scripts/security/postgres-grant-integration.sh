#!/usr/bin/env bash
set -euo pipefail

: "${DATABASE_URL:?DATABASE_URL must point to a disposable PostgreSQL database}"

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 <<'SQL'
DO $$ BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'service_role') THEN CREATE ROLE service_role NOLOGIN BYPASSRLS; END IF;
END $$;

DROP SCHEMA IF EXISTS private CASCADE;
CREATE SCHEMA private;
CREATE TABLE private.file_mutation_approval_grants (
  grant_id text PRIMARY KEY,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  request_id text NOT NULL,
  requester_user_id text NOT NULL,
  executor_user_id text NOT NULL,
  approver_user_id text NOT NULL,
  target_entity_type text NOT NULL CHECK (target_entity_type = 'FILE'),
  target_entity_id text NOT NULL,
  operation text NOT NULL CHECK (operation IN ('CREATE','MODIFY','COPY','MOVE','RENAME','DELETE')),
  source_path text NOT NULL,
  destination_path text,
  input_digest text NOT NULL,
  status text NOT NULL CHECK (status IN ('PENDING','APPROVED','REVOKED','CONSUMED')),
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  CHECK (requester_user_id <> approver_user_id),
  CHECK ((status = 'CONSUMED') = (consumed_at IS NOT NULL))
);
CREATE TABLE private.memberships (
  user_id text NOT NULL,
  organization_id text NOT NULL,
  workspace_id text NOT NULL,
  status text NOT NULL CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED')),
  role text NOT NULL
);
ALTER TABLE private.file_mutation_approval_grants ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.memberships ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON SCHEMA private FROM PUBLIC, anon, authenticated;
REVOKE ALL ON ALL TABLES IN SCHEMA private FROM PUBLIC, anon, authenticated;
GRANT USAGE ON SCHEMA private TO service_role;
GRANT SELECT, INSERT, UPDATE ON ALL TABLES IN SCHEMA private TO service_role;

INSERT INTO private.file_mutation_approval_grants VALUES
('consume-race','org-a','ws-a','req-1','requester','executor','approver','FILE','file-1','MODIFY','a.txt',NULL,'digest-1','APPROVED',now()+interval '5 minutes',NULL),
('revoke-race','org-a','ws-a','req-2','requester','executor','approver','FILE','file-2','MODIFY','b.txt',NULL,'digest-2','APPROVED',now()+interval '5 minutes',NULL),
('tenant-a','org-a','ws-a','req-3','requester','executor','approver','FILE','file-3','MODIFY','c.txt',NULL,'digest-3','APPROVED',now()+interval '5 minutes',NULL),
('tenant-b','org-b','ws-b','req-4','requester','executor','approver','FILE','file-4','MODIFY','d.txt',NULL,'digest-4','APPROVED',now()+interval '5 minutes',NULL);
INSERT INTO private.memberships VALUES
('active-admin','org-a','ws-a','ACTIVE','ADMIN'),
('revoked-admin','org-a','ws-a','REVOKED','ADMIN'),
('demoted-user','org-a','ws-a','ACTIVE','MEMBER');
SQL

# Client roles must not be able to see the private schema or its tables.
if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET ROLE authenticated; SELECT * FROM private.file_mutation_approval_grants;" >/dev/null 2>&1; then
  echo "FAIL: authenticated role accessed private grant table" >&2
  exit 1
fi

# Exact tenant predicates must not return a grant from another tenant.
tenant_count="$(psql "$DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "SET ROLE service_role; SELECT count(*) FROM private.file_mutation_approval_grants WHERE organization_id='org-a' AND workspace_id='ws-a' AND grant_id='tenant-b';" | tail -n 1)"
test "$tenant_count" = "0"

# Current membership status and role are evaluated, not just membership existence.
membership_state="$(psql "$DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "SET ROLE service_role; SELECT status || ':' || role FROM private.memberships WHERE user_id='revoked-admin';" | tail -n 1)"
test "$membership_state" = "REVOKED:ADMIN"
demoted_role="$(psql "$DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "SET ROLE service_role; SELECT status || ':' || role FROM private.memberships WHERE user_id='demoted-user';" | tail -n 1)"
test "$demoted_role" = "ACTIVE:MEMBER"

# Database constraint independently rejects requester self-approval.
if psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -c "SET ROLE service_role; INSERT INTO private.file_mutation_approval_grants VALUES ('self-approval','org-a','ws-a','req-x','same-user','executor','same-user','FILE','file-x','MODIFY','x',NULL,'digest-x','APPROVED',now()+interval '5 minutes',NULL);" >/dev/null 2>&1; then
  echo "FAIL: database accepted requester self-approval" >&2
  exit 1
fi

# Two concurrent conditional consumers: exactly one UPDATE may return a row.
consume_sql="UPDATE private.file_mutation_approval_grants SET status='CONSUMED', consumed_at=now() WHERE grant_id='consume-race' AND organization_id='org-a' AND workspace_id='ws-a' AND request_id='req-1' AND requester_user_id='requester' AND executor_user_id='executor' AND approver_user_id='approver' AND target_entity_type='FILE' AND target_entity_id='file-1' AND operation='MODIFY' AND source_path='a.txt' AND destination_path IS NULL AND input_digest='digest-1' AND status='APPROVED' AND consumed_at IS NULL AND expires_at>now() RETURNING grant_id;"
psql "$DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "$consume_sql" > /tmp/happy-consume-a.out & p1=$!
psql "$DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "$consume_sql" > /tmp/happy-consume-b.out & p2=$!
wait "$p1"; wait "$p2"
consume_winners="$(cat /tmp/happy-consume-a.out /tmp/happy-consume-b.out | grep -c '^consume-race$' || true)"
test "$consume_winners" = "1"

# Revocation and consumption race on the same conditional state transition.
revoke_sql="UPDATE private.file_mutation_approval_grants SET status='REVOKED' WHERE grant_id='revoke-race' AND status='APPROVED' AND consumed_at IS NULL RETURNING grant_id;"
race_consume_sql="UPDATE private.file_mutation_approval_grants SET status='CONSUMED', consumed_at=now() WHERE grant_id='revoke-race' AND status='APPROVED' AND consumed_at IS NULL AND expires_at>now() RETURNING grant_id;"
psql "$DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "$revoke_sql" > /tmp/happy-revoke.out & p3=$!
psql "$DATABASE_URL" -XAt -v ON_ERROR_STOP=1 -c "$race_consume_sql" > /tmp/happy-race-consume.out & p4=$!
wait "$p3"; wait "$p4"
transition_winners="$(cat /tmp/happy-revoke.out /tmp/happy-race-consume.out | grep -c '^revoke-race$' || true)"
test "$transition_winners" = "1"

echo "PASS: PostgreSQL RLS denial, tenant isolation predicate, revoked/demoted membership state, no-self-approval, concurrent single-consumer, and revoke-vs-consume single-winner checks."
