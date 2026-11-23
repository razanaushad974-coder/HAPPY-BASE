-- Disposable PostgreSQL 17 privilege probe.
-- Run only on a throwaway database as a database administrator.
-- Entire test rolls back. Creates no persistent objects.
BEGIN;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_catalog.pg_roles WHERE rolname = 'happy_for_share_probe') THEN
    CREATE ROLE happy_for_share_probe
      NOLOGIN NOINHERIT NOSUPERUSER NOCREATEDB NOCREATEROLE NOREPLICATION NOBYPASSRLS;
  END IF;
END
$$;

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
  FOR SELECT TO happy_for_share_probe
  USING (tenant_id = 'tenant-a');

GRANT USAGE ON SCHEMA happy_for_share_probe TO happy_for_share_probe;
GRANT SELECT ON happy_for_share_probe.scope_rows TO happy_for_share_probe;

-- Probe A: SELECT + RLS SELECT policy, but no UPDATE privilege.
-- PostgreSQL is expected to reject SELECT ... FOR SHARE with insufficient_privilege.
SET LOCAL ROLE happy_for_share_probe;
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
-- RLS policy. The role can acquire the row lock, while UPDATE remains blocked by RLS.
GRANT UPDATE (lock_marker) ON happy_for_share_probe.scope_rows TO happy_for_share_probe;

SET LOCAL ROLE happy_for_share_probe;
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
