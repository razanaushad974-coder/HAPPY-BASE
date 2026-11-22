# Durable mission scheduler SQL candidate review — 2026-11-22

## Scope

Read-only review of `supabase/drafts/20261121_durable_mission_scheduler_candidate.sql` against:

- `supabase/drafts/20261119_async_tenant_persistence_schema_candidate.sql`
- `supabase/drafts/20261119_file_mutation_atomic_consume_candidate.sql`
- `src/core/mission/types.ts`
- `src/core/mission/task-graph.ts`
- `src/core/mission/mission-engine.ts`

No database was connected or modified. This is a design review, not a migration approval.

## Confirmed schema alignment

- The draft's `happy_tenant_records` entity types include `MISSION`, `TASK`, and `EXECUTION`.
- Mission/task records use `record_id`, `data.missionId`, `data.taskIds`, `data.status`, and `data.dependencyIds`, matching the TypeScript mission/task model.
- The draft's composite workspace foreign key matches the candidate identity schema's `private.workspaces(organization_id, workspace_id)` unique key.
- The lease claim's bounded duration (5,000–300,000 ms), tenant-bound record lookups, task version check, lease fencing token, and fail-closed ambiguous-dispatch handling are useful foundations.

## Blocking findings — do not deploy this candidate

### P0 — Dispatch enqueue is not bound to a persisted execution request or approval

`happy_enqueue_mission_dispatch` accepts caller-supplied `execution_request_id`, capability, action, payload, and digest. It checks that the payload repeats those same caller-supplied values, but it does not load and lock the corresponding `private.execution_requests` row, verify its immutable envelope, or verify the persisted approval/grant decision for that exact request and task.

Consequently, a tenant member who can obtain a lease could enqueue an arbitrary action/payload under a fabricated request ID. The enqueue RPC must derive and verify the request from the authenticated tenant, bind the full immutable request envelope and digest, verify the persisted approval authority for approval-sensitive work, and reject any mismatch before inserting the outbox row. The outbox must never be treated as approval authority.

### P0 — No trusted worker identity is established

The claim/enqueue/heartbeat/outcome functions use `auth.uid()` (a human Supabase user session) and caller-supplied `p_owner_id`. This does not attest a worker workload identity, issuer, audience, deployment, capability, or token lifetime. A caller-supplied owner string is data, not proof of worker identity.

Keep worker claim, dispatch, heartbeat, and outcome recording unavailable until a concrete hosting/runtime workload identity is verified and bound server-side. Do not repurpose the human-session identity provider as a worker identity provider.

### P1 — Claim does not enforce task approval and retry policy

The TypeScript task model includes `requiresApproval`, `retryCount`, and `maxRetries`. The SQL claim checks mission/task status and dependencies, but does not enforce approval evidence for a task that requires approval and does not enforce the retry counter/maximum. Claim eligibility must be bound to the persisted execution request/approval lifecycle and retry policy, not merely a mutable `READY` status.

### P1 — Graph integrity is only partially checked at claim time

The RPC verifies each listed dependency exists, belongs to the mission, and is COMPLETED. It does not prove that the mission's full `taskIds` list has a one-to-one matching task snapshot, reject duplicate IDs, or validate all dependency references/cycles as `TaskGraphEngine` does. Persisted graph creation/update must enforce the complete invariant transactionally; claim should fail closed if the stored graph is incomplete or malformed.

### P1 — Outbox immutability and legal state transitions are not enforced

The outbox table has status checks, but the candidate has no immutable-binding trigger or transition guard. The outcome RPC limits its own transitions, but table-level protections against alternate owner paths are not established. Enforce immutable tenant/request/task/lease/idempotency/capability/action/digest/payload fields and a monotonic state machine; revoke all direct table DML and verify function-owner privileges.

### P1 — Retry attempt and task state need one canonical transition

The SQL increments the lease attempt on lease reclaim, while the persisted task has its own `retryCount` and `maxRetries`. These counters are not currently bound. Define whether a lease reclaim is recovery or a task retry; only an explicit, approved retry transition should increment the task retry count and restore eligibility. A lease expiry alone must not authorize replay of a possibly completed external side effect.

## Required implementation order

1. Keep this SQL candidate design-only and all worker/dispatch operations `NOT_YET_CONNECTED`.
2. Define a canonical immutable execution-request/approval binding shared by the execution-request store, approval verifier, and outbox RPC.
3. Add workload identity verification before exposing worker-facing RPCs.
4. Add transactional full mission/task graph integrity checks and explicit retry transitions.
5. Add outbox immutable-binding/state-transition enforcement and least-privilege ownership.
6. Add adversarial PostgreSQL tests for fabricated request IDs, missing/revoked approvals, mismatched payload/digest, forged owner IDs, stale fencing tokens, malformed graphs, retry exhaustion, and concurrent idempotency.
7. Only after these pass against disposable PostgreSQL and real Supabase JWT/workload identity should a separate migration review be considered.

## Status

- Candidate SQL: **BLOCKED — DESIGN ONLY**
- Hosted Supabase changes: **NONE**
- Worker identity / durable dispatch runtime: **NOT_YET_CONNECTED**
- This review does not authorize migration, production deployment, merge, or changes to `main`.


## Follow-up containment patch — 2026-11-22

The scheduler candidate previously granted the `authenticated` role EXECUTE on human-session RPCs for task claim, lease heartbeat, dispatch enqueue/claim, outcome recording, and reconciliation evidence. That is not an acceptable worker trust boundary: `auth.uid()` authenticates a human Supabase user, while `p_owner_id` is caller-controlled data.

- Removed the `authenticated` EXECUTE grants from all seven scheduler/dispatch/reconciliation RPCs.
- Explicitly revoked EXECUTE from `PUBLIC`, `anon`, `authenticated`, and `service_role` for those functions.
- Kept the candidate functions inert until a dedicated workload identity, server-side identity-to-lease binding, and narrowly privileged function-owner model are implemented and tested.
- Verified statically that each of the seven functions has an authenticated revoke and no authenticated grant.

Commits: `7c28b79cbd85ba74e8fc716a94a9073cec1407a3`, followed by correction `84e4429ec3451557e60428617c47c8d38c521470`.

This is a fail-closed SQL-candidate containment change, not a worker implementation. It has not yet received exact-commit CI validation; no database was connected or modified. The candidate remains design-only and must not be applied until request/approval binding, graph/retry invariants, workload identity, outbox immutability, and hosted role ownership are resolved.
