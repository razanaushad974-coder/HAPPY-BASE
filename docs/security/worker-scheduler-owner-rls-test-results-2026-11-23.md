# Worker scheduler owner / CONTROL-VERIFY RLS probe — 2026-11-23

## Candidate model

A separate `NOLOGIN / NOINHERIT / NOBYPASSRLS` role candidate now exists for the eight worker scheduler SECURITY DEFINER RPCs:

- `supabase/drafts/20261123_worker_scheduler_rpc_owner_role_candidate.sql`
- `supabase/drafts/20261123_worker_scheduler_rpc_owner_privilege_candidate.sql`

The registry owner candidate now also defines `private.happy_worker_tenant_scope_policy(org,workspace,user,capability)`. It derives the principal from PostgreSQL `session_user`, rechecks the live worker registry, worker-to-tenant grant and canonical memberships, and fails closed. EXECUTE is granted only to the scheduler owner role.

The scheduler privilege candidate scopes:
- CONTROL: mission/task snapshots, fenced leases, outbox lifecycle, and approved execution-request status.
- VERIFY: mission/task/outbox/evidence reads and reconciliation evidence insertion.
- VERIFY outbox row locking: a separate UPDATE policy with `USING (VERIFY scope) WITH CHECK (false)`; no outbox mutation is allowed to a VERIFY-only principal.
- Execution request writes: status column only; approval envelope columns remain immutable to the worker scheduler owner.

## Focused hosted test

**PASS — VERIFY-only outbox lock probe completed on Supabase PostgreSQL 17.12.**

- Script: `scripts/security/test-worker-verify-outbox-lock-only.sql`
- Blob SHA: `c001b0ca0737f3537fc895fae0524660dab012bf`
- A synthetic registry principal had VERIFY only, not CONTROL.
- The worker scope helper verified the principal, tenant grant and active organization/workspace memberships using `session_user`.
- `SELECT ... FOR SHARE` returned the ambiguous outbox row.
- An attempted UPDATE was rejected by the lock-only RLS policy.
- The transaction rolled back; catalog verification confirmed probe roles and schema were absent.

## Important capability-composition finding

PostgreSQL permissive RLS policies combine with OR. A worker principal that has both CONTROL and VERIFY satisfies the CONTROL outbox UPDATE policy as well as the VERIFY lock policy. That is expected: such a principal is authorized for CONTROL. The focused test therefore uses a VERIFY-only principal to prove that VERIFY alone cannot mutate outbox rows. The separate function EXECUTE grants still determine which RPCs a worker LOGIN can invoke.

An extended full scheduler matrix script was added, but the SQL runner disconnected before returning a result on its corrected full-batch attempt. It is **not counted as passed**:
- `scripts/security/test-worker-scheduler-owner-grants.sql`

## Remaining gates

- Re-run the extended CONTROL lifecycle matrix in a local PostgreSQL 17 harness or a supported isolated database session.
- Validate exact table/column grants against the real HAPPY scheduler tables after a reviewed staging migration chain exists.
- Test worker LOGIN identity through the actual Supabase pooler and verify `session_user` is preserved.
- Verify role-specific EXECUTE grants against registered dedicated worker LOGIN roles.
- Test lease fencing, late provider responses, outbox crash recovery, revocation and tenant isolation under concurrent sessions.

**Disposition: PARTIAL PASS — the focused VERIFY-only lock/mutation boundary passed. The full worker scheduler owner matrix and actual hosted worker identity remain unverified. No role, grant, migration, or worker credential was persisted.**
