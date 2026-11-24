# PostgreSQL 17.12 row-lock / RLS semantics — corrected test result (2026-11-23)

## Corrected conclusion

**A row-locking SELECT needs both an UPDATE SQL privilege and an UPDATE RLS policy whose `USING` expression admits the row.** A SELECT policy alone is insufficient: `SELECT ... FOR SHARE` can silently return zero rows under RLS rather than raising an error.

A lock-only UPDATE policy using `USING (true) WITH CHECK (false)` allows the row to be selected and locked, while rejecting every UPDATE mutation.

## Why the first probe was insufficient

The initial probe checked that `SELECT ... FOR SHARE` did not throw, but it did not assert that a row was actually returned/locked. It therefore incorrectly treated a zero-row result as success. The first report's conclusion that an UPDATE RLS policy was unnecessary was wrong and has been superseded.

The test script was corrected to assert `FOUND` after the locking SELECT and to verify that a mutation attempt is rejected.

## Verified on staging

- Project ref: `kcbbfwtvkjepvtbmbrse`
- Database: `postgres`
- PostgreSQL: `17.12`
- Updated script: `scripts/security/test-for-share-row-lock-privileges.sql`
- Script blob SHA: `7b8e04a20dc16faaaf7a13bb9d32f25e56f5c1a5`
- Execution: successful; all assertions completed in a transaction ending with `ROLLBACK`.

### Probe A — SELECT policy only

- SELECT privilege and SELECT RLS policy were present.
- Column-level UPDATE privilege was present.
- No UPDATE RLS policy existed.
- `SELECT ... FOR SHARE` returned no row (`FOUND = false`).
- This is not a successful lock.

### Probe B — lock-only UPDATE policy

Added:

```sql
CREATE POLICY ... FOR UPDATE TO authenticated
USING (true)
WITH CHECK (false);
```

Observed:

- `SELECT ... FOR SHARE` returned the intended row (`FOUND = true`).
- UPDATE was rejected with `insufficient_privilege` due to the false WITH CHECK expression.
- The marker column remained unchanged.

## Design consequence

For the worker registry owner, do not remove UPDATE policies entirely and do not use `WITH CHECK (true)`. The correct lock-only policy is:

- `USING (true)` — permits the row to be found/locked by `FOR SHARE`.
- `WITH CHECK (false)` — rejects all attempted new row values.
- Column-level UPDATE grants only on the exact columns needed for the lock privilege check.
- No INSERT or DELETE grants and no API/worker-login membership in the function owner.

The worker registry candidate has been updated to use six lock-only policies with `USING (true) WITH CHECK (false)`.

## Safety / scope

The probe ran in a single transaction and was rolled back. Post-run checks confirmed the probe schema and table were absent. No HAPPY migrations, roles, grants, credentials, or application data were persisted. No production project was accessed or changed.
