-- Disposable PostgreSQL 17 row-lock / RLS probe.
-- Run only on an isolated test database as a database administrator.
-- Entire test rolls back. Creates no persistent objects.
BEGIN;

CREATE SCHEMA happy_for_share_probe;
CREATE TABLE happy_for_share_probe.scope_rows (
  id bigint PRIMARY KEY,
  lock_marker boolean NOT NULL DEFAULT false
);
INSERT INTO happy_for_share_probe.scope_rows (id) VALUES (1);

ALTER TABLE happy_for_share_probe.scope_rows ENABLE ROW LEVEL SECURITY;
CREATE POLICY happy_for_share_probe_select
  ON happy_for_share_probe.scope_rows
  FOR SELECT TO authenticated
  USING (true);

GRANT USAGE ON SCHEMA happy_for_share_probe TO authenticated;
GRANT SELECT ON happy_for_share_probe.scope_rows TO authenticated;
GRANT UPDATE (lock_marker) ON happy_for_share_probe.scope_rows TO authenticated;

-- Probe A: no UPDATE RLS policy. FOR SHARE does not throw; RLS filters the
-- row from the locking SELECT, so FOUND must be false.
SET LOCAL ROLE authenticated;
DO $without_update_policy$
BEGIN
  PERFORM id
    FROM happy_for_share_probe.scope_rows
   WHERE id = 1
   FOR SHARE;

  IF FOUND THEN
    RAISE EXCEPTION 'FAIL: FOR SHARE unexpectedly saw a row without UPDATE policy';
  END IF;
END
$without_update_policy$;
RESET ROLE;

-- Probe B: UPDATE USING allows the row to be locked, but WITH CHECK false
-- rejects every attempted mutation.
CREATE POLICY happy_for_share_probe_lock_only
  ON happy_for_share_probe.scope_rows
  FOR UPDATE TO authenticated
  USING (true)
  WITH CHECK (false);

SET LOCAL ROLE authenticated;
DO $lock_only$
DECLARE
  affected bigint;
BEGIN
  PERFORM id
    FROM happy_for_share_probe.scope_rows
   WHERE id = 1
   FOR SHARE;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'FAIL: FOR SHARE did not return the row under lock-only UPDATE policy';
  END IF;

  BEGIN
    UPDATE happy_for_share_probe.scope_rows
       SET lock_marker = true
     WHERE id = 1;
    GET DIAGNOSTICS affected = ROW_COUNT;
    RAISE EXCEPTION 'FAIL: UPDATE unexpectedly completed; affected=%', affected;
  EXCEPTION
    WHEN insufficient_privilege THEN
      RAISE NOTICE 'PASS: lock-only UPDATE policy rejects row mutation';
  END;
END
$lock_only$;
RESET ROLE;

DO $verify$
DECLARE
  marker boolean;
BEGIN
  SELECT lock_marker INTO marker
    FROM happy_for_share_probe.scope_rows
   WHERE id = 1;
  IF marker IS DISTINCT FROM false THEN
    RAISE EXCEPTION 'FAIL: row marker changed';
  END IF;
END
$verify$;

ROLLBACK;
