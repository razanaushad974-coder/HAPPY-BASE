# Durable dispatch outbox immutability and transition review — 2026-11-22

## Scope
Read-only source review of `supabase/drafts/20261121_durable_mission_scheduler_candidate.sql` on `platform/full-happy-audit-and-integration`.

No repository code or database was modified by this review. No migration is approved.

## Confirmed findings

### P0 — Outbox immutability is not enforced at the table boundary
The candidate creates `public.happy_execution_dispatch_outbox` with tenant-scoped uniqueness and revokes table privileges from `PUBLIC`, `anon`, `authenticated`, and `service_role`. However, the inspected scheduler SQL defines no trigger that rejects changes to immutable dispatch bindings.

The fields that must remain immutable after insertion include:
- tenant/user scope, outbox ID, mission/task, lease ID, fencing token and attempt;
- execution request ID and idempotency key;
- capability, action, payload digest and payload;
- creation timestamp.

The outcome RPC updates status, outcome and updated_at, but table-level immutability is not independently enforced against alternate privileged write paths or future function-owner mistakes. Add a trigger that rejects any mutation of immutable fields, and a separate legal-transition guard that allows only the intended one-time `PENDING -> DISPATCHED -> terminal outcome` progression. The trigger must not mistake the permitted status/outcome/updated_at transition for an immutable-binding mutation.

### P1 — Terminal outcome transition contract needs explicit monotonic guard
`happy_record_dispatch_outcome` requires current status `DISPATCHED` and performs a conditional update. This protects that RPC path, but no table-level transition guard currently protects alternate privileged update paths. Explicitly reject terminal-to-anything transitions and changes to an already-recorded outcome.

### P1 — Outcome RPC does not check lease expiry
The outcome RPC binds lease ID, owner ID and fencing token, but the inspected condition does not reject an expired lease. Define the intended policy carefully: if a provider call began under a valid lease and its response arrives after expiry, a blanket expiry rejection may lose valid evidence. Prefer a narrowly defined late-outcome acceptance rule tied to the same immutable outbox dispatch, unchanged fencing token, and no replacement lease; otherwise append reconciliation evidence rather than silently dropping the provider result. Add tests for late response, lease reclaim, stale fencing token, and replacement owner.

### Existing containment that must remain
- Worker RPC EXECUTE privileges are revoked from `PUBLIC`, `anon`, `authenticated`, and `service_role`.
- Direct table privileges are revoked.
- The scheduler candidate remains design-only.
- Do not restore grants or apply this candidate to hosted Supabase until a dedicated cryptographically verified workload identity and least-privilege database principal are implemented.

## Required tests
1. Direct privileged update attempts to mutate each immutable binding field fail.
2. Legal first outcome transition succeeds exactly once.
3. Terminal status/outcome mutation and terminal replay fail.
4. Concurrent outcome writers yield exactly one durable result.
5. Expired lease with unchanged fence, replaced lease, stale fence, and delayed provider response follow the documented late-outcome/reconciliation policy.
6. Worker-facing RPCs remain non-executable by human, anonymous, and broad service roles.
7. Run the full disposable PostgreSQL security harness and record the exact commit/workflow result; do not describe static review as CI verification.

## Status
- Outbox immutable-binding trigger: NOT IMPLEMENTED in inspected candidate.
- Table-level monotonic state-transition guard: NOT IMPLEMENTED in inspected candidate.
- Late-outcome policy: NEEDS DESIGN.
- Worker identity / least-privilege DB bridge: BLOCKED / NOT_YET_CONNECTED.
- Hosted Supabase: NOT MODIFIED.
- Main branch: NOT MODIFIED.
