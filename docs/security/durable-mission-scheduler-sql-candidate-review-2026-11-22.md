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


## CI correction for fail-closed worker grants — 2026-11-22

The workflow for the preceding worker-identity contract commit reached TypeScript and the complete security harness successfully, then failed in PostgreSQL integration because the scheduler SQL test still invoked worker-gated RPCs under the `authenticated` role. The SQL candidate correctly revoked those EXECUTE grants, so this was a stale test-harness assumption, not a reason to restore grants.

Updated `scripts/security/postgres-tenant-persistence-integration.sh`:
- Scheduler SQL state-machine assertions now run as the isolated disposable PostgreSQL owner after test tenant records are created. The simulated `auth.uid()` claim remains set, so tenant membership and tenant binding logic still execute.
- Added explicit assertions that all seven worker-facing RPCs are not executable by `authenticated`, `anon`, or `service_role`.
- Retained the separate assertions denying direct access to scheduler/outbox/reconciliation tables and the existing lease, fencing, outbox, idempotency, outcome and reconciliation behavior tests.
- This validates SQL behavior in a local disposable database only. It does not grant application roles, authenticate a production worker, or establish hosted Supabase compatibility.

The failed CI run is recorded as a failure; it is not represented as a pass. A fresh workflow run on the corrected commit is required.


## P0 persisted execution-envelope binding gap confirmed — 2026-11-22

A follow-up source comparison confirmed that the scheduler enqueue candidate still cannot prove that its request ID and supplied payload correspond to the canonical persisted execution request:

- The design-only `private.execution_requests` table in `20261119_file_mutation_atomic_consume_candidate.sql` currently stores only request/task/mission IDs, requester/executor user IDs, organization/workspace IDs, and status. It does not persist capability, action, input, target reference, immutable envelope digest, idempotency key, approval requirement, or approval decision binding.
- The TypeScript creation-client contract in `src/core/tenant/supabase-private-tenant-stores.ts` already expects capability, action, input, target reference, and idempotency key, but a corresponding `create_authenticated_execution_request` SQL implementation was not found in the inspected draft candidates.
- `happy_enqueue_mission_dispatch` currently checks that caller-supplied JSON top-level ID/mission/task/capability/action match its parameters and checks only that the digest has SHA-256 syntax. It does not lock and compare a canonical persisted request envelope or recompute the digest from persisted immutable fields.

This remains a P0 blocker even though worker RPCs are fully grant-revoked. Do not restore any grants. The next SQL design change must first add a canonical immutable request envelope and an authenticated creation/decision lifecycle that matches the TypeScript contract; it must bind the exact request to tenant, requester, executor, mission, task, capability, action, input, target reference, idempotency key, approval requirement, and persisted approval. The enqueue function must then lock that exact request, derive/verify the digest from persisted columns, compare the complete envelope and lease/attempt binding, and reject missing, cancelled, completed, mismatched, or unapproved requests before outbox insertion. The disposable PostgreSQL harness must include fabricated request IDs, altered input/action/capability, stale/revoked/missing approval, idempotency reuse, and concurrent enqueue attacks.

No implementation is claimed for this P0 gap yet. It is intentionally left blocked until the canonical request and approval lifecycle can be designed end-to-end without inventing or bypassing the missing producer authority.


## Persisted execution envelope and founder approval binding implemented in candidate — 2026-11-22

The earlier P0 request-binding gap has now been addressed in the design-only SQL candidates. The canonical lifecycle is the existing `supabase/drafts/20261121_authenticated_execution_envelope_candidate.sql`; the scheduler enqueue implementation is in `supabase/drafts/20261121_durable_mission_scheduler_candidate.sql`. No second competing request-lifecycle migration is retained.

### Request creation and approval lifecycle

- The execution-request table now has a complete immutable envelope: capability, action, JSON input, target reference, requester/executor, organization/workspace, mission/task, HIGH risk, required Founder approval, input digest, envelope digest, request-creation idempotency key, and creation timestamp.
- New enveloped requests must start `WAITING_APPROVAL` with `approval_status=PENDING`; direct legacy inserts cannot mint a pre-approved executable request.
- The authenticated creation RPC derives requester and executor from `auth.uid()`, validates active organization/workspace membership, and binds mission/task selectors to same-user/same-tenant persisted records. The mission must contain the task ID and the task must point back to the mission.
- Exact idempotent request retries return the original persisted request and timestamp. Reuse of the same key with a different action/input/envelope is rejected.
- The authenticated decision RPC locks the request, organization, workspace, and both memberships; requires an active organization FOUNDER plus an allowed active workspace role; rejects self-approval; and atomically changes the request from `WAITING_APPROVAL/PENDING` to `READY/APPROVED` or `CANCELLED/REJECTED`.
- Approval decision evidence is append-only. Legacy rows without a complete envelope remain non-executable and are not returned by the new executor-bound resolver.
- Current producer contract does not accept a trusted risk classification, so the database conservatively classifies every request as HIGH and requires Founder approval. This is deliberately restrictive, not a final risk-policy design.

### Enqueue now verifies persisted authority

Before an outbox insert, `happy_enqueue_mission_dispatch`:

1. Locks the current lease and exact persisted execution-request row, scoped to organization, workspace, user, mission, and task.
2. Requires `READY`, `APPROVED`, `requires_approval=true`, `required_approval_role=FOUNDER`, a distinct persisted `decided_by`, and decision timestamp.
3. Recomputes the stored input digest and immutable envelope digest from persisted fields; it does not trust a caller-supplied request digest.
4. Reconstructs the exact execution payload (including `approved=true`, HIGH risk, target reference and persisted creation time) and requires structural equality with caller payload.
5. Recomputes the payload digest and rejects any digest or payload mismatch.
6. Recomputes the dispatch idempotency key from tenant scope, mission, task, lease attempt, request ID, capability, and action. This is deliberately separate from the request-creation idempotency key.
7. Preserves the existing tenant-scoped outbox uniqueness and exact idempotent-retry comparison.

The TypeScript durable-request store now normalizes database timestamps to ISO milliseconds before rebuilding the execution request, and the creator always sends explicit SQL NULL for an absent target reference. New tests cover the creator/decision adapters and timestamp normalization. The SQL static contract test now checks the persisted request lock, Founder approval, digest recomputation, exact payload binding, attempt-bound idempotency, and retained worker grant revocation.

### Disposable PostgreSQL verification

The PostgreSQL integration harness now applies the canonical envelope candidate after the base request RPC and:
- Creates two canonical requests through the authenticated RPC.
- Verifies exact idempotent creation and rejects same-key/different-action reuse.
- Verifies requester self-approval returns false and a separate FOUNDER decision succeeds.
- Leaves a third request pending and verifies enqueue denies it.
- Verifies a fabricated request ID and altered payload cannot enqueue.
- Verifies complete envelopes resolve to their executor while legacy incomplete rows are hidden.
- Exercises the scheduler outbox using persisted approved requests and attempt-bound idempotency keys.
- Resolves reconciliation concurrency tests using the persisted outbox idempotency key rather than the older request-creation key.

GitHub Actions run `45025306413` on code commit `8fdb98806affd38e36142e3cb078ecf0f84ffdc6` completed **SUCCESS**. TypeScript, the complete security harness, PostgreSQL RLS/CAS + scheduler/outbox/reconciliation integration, orchestration/mission harnesses, ESLint, dependency audit, and production build all passed. The run uses a disposable PostgreSQL 17 database with a local `auth.uid()` claim stub.

### Remaining blockers — do not deploy or grant worker access

- All worker/dispatch/reconciliation RPC EXECUTE grants remain revoked from `PUBLIC`, `anon`, `authenticated`, and `service_role`.
- A dedicated Vercel worker project/runtime, supported OIDC token source, cryptographic JWKS verifier, and worker registry are still NOT_YET_CONNECTED.
- The database bridge must preserve the distinction between verified workload identity and the original human tenant actor; Vercel OIDC `sub` is not a Supabase `auth.uid()` UUID.
- Scheduler function ownership and the least-privilege database principal for a future worker remain unresolved. Do not use broad `service_role` as a substitute.
- The request lifecycle currently has no post-approval revocation RPC; decision evidence is one final append-only event per request. A reviewed revocation/cancellation path must be designed before claiming approval revocation support.
- Cross-language canonical digest parity should receive explicit edge-case coverage for Unicode object keys and unusual numeric representations before production wiring. The current disposable harness verifies the selected JSON payloads and SQL digest path; it is not proof of every JSON serialization edge case.
- No hosted Supabase migration, Vercel setting, production deployment, or `main` change was performed.

**Status:** persisted request + Founder approval + enqueue binding are implemented and CI-verified in design-only candidates; production worker authentication and dispatch remain BLOCKED / NOT_YET_CONNECTED.
