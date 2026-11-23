-- Disposable PostgreSQL 17 / Supabase privilege probe.
-- Run only on an isolated test database as a database administrator.
-- Uses Supabase's built-in authenticated role so SET LOCAL ROLE is supported.
-- Entire test rolls back. Creates no persistent objects.
BEGIN;

DO $preflight$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'authenticated') THEN
    RAISE EXCEPTION 'Missing Supabase authenticated role; use a Supabase test database';
  END IF;
  IF NOT pg_catalog.pg_has_role(current_user, 'authenticated', 'MEMBER') THEN
    RAISE EXCEPTION 'Current database role cannot SET ROLE authenticated';
  END IF;
END
$preflight$;

CREATE SCHEMA happy_for_share_probe;
CREATE TABLE happy_for_share_probe.scope_rows (
  id bigint PRIMARY KEY,
  tenant_id text NOT NULL,
  lock_marker boolean NOT NULL DEFAULT false
);
INSERT INTO happy_for_share_probe.scope_rows (id, tenant_id) VALUES (1, 'tenant-a');

ALTER TABLE happy_for_share_probe.scope_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY happy_for_share_probe_select
  ON happy_for_share_probe.scope_rows
  FOR SELECT TO authenticated
  USING (tenant_id = 'tenant-a');

GRANT USAGE ON SCHEMA happy_for_share_probe TO authenticated;
GRANT SELECT ON happy_for_share_probe.scope_rows TO authenticated;

-- Probe A: SELECT + RLS SELECT policy, but no UPDATE privilege.
-- PostgreSQL should reject SELECT ... FOR SHARE with insufficient_privilege.
SET LOCAL ROLE authenticated;
DO $probe$
BEGIN
  BEGIN
    PERFORM id
    FROM happy_for_share_probe.scope_rows
    WHERE id = 1
    FOR SHARE;
    RAISE EXCEPTION 'FAIL: FOR SHARE unexpectedly succeeded without UPDATE privilege';
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS: FOR SHARE requires an UPDATE privilege in addition to SELECT';
  END;
END
$probe$;
RESET ROLE;

-- Probe B: grant UPDATE on one inert marker column, but do not create an UPDATE
-- RLS policy. The role can acquire the row lock, while UPDATE must affect zero rows.
GRANT UPDATE (lock_marker) ON happy_for_share_probe.scope_rows TO authenticated;

SET LOCAL ROLE authenticated;
DO $probe$
DECLARE
  affected bigint;
BEGIN
  PERFORM id
  FROM happy_for_share_probe.scope_rows
  WHERE id = 1
  FOR SHARE;

  UPDATE happy_for_share_probe.scope_rows
     SET lock_marker = true
   WHERE id = 1;
  GET DIAGNOSTICS affected = ROW_COUNT;

  IF affected <> 0 THEN
    RAISE EXCEPTION 'FAIL: UPDATE changed a row without an UPDATE RLS policy';
  END IF;

  RAISE NOTICE 'PASS: FOR SHARE succeeds with column UPDATE grant; RLS without UPDATE policy blocks row mutation';
END
$probe$;
RESET ROLE;

ROLLBACK;
