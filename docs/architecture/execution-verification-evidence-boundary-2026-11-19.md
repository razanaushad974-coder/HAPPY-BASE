# HAPPY execution, verification, and evidence boundary review

**Date:** 2026-11-19  
**Branch:** `platform/full-happy-audit-and-integration`  
**Scope:** Read-only inspection of the current orchestration, state, evidence, and verification source paths.

## Verified composition

The current `HappyOrchestrationEngine` constructs a `PersistenceService` backed by `JsonFileStateAdapter` at `.happy-state/orchestration-state.json`. During each run it constructs a legacy `HappyStateStore` for the request's organization, workspace, and user. It also constructs `PersistentMemoryService` with the same synchronous persistence instance.

The evidence/verification path is separate:

- `EvidenceRepository` is a synchronous interface.
- `InMemoryEvidenceRepository` stores evidence in a process-local `Map`.
- `EvidenceService` validates required verification, mission, task, and title fields, then delegates synchronously to that repository.
- `VerificationEngine` accepts the `EvidenceService`, filters observed IDs by calling `get()`, and does not persist verification results through the async tenant repository.
- `VerificationEngine` explicitly returns `PARTIAL` with `SEMANTIC_VERIFIER_NOT_CONNECTED` when required criteria exist; evidence presence is not represented as proof that the requested outcome occurred.

## Security and correctness consequences

1. Evidence IDs are currently process-local; evidence is lost on process restart and is not shared across workers.
2. Evidence reads are keyed by evidence ID or task/verification ID only; the repository interface has no organization/workspace/user scope.
3. Verification trusts the caller-supplied observed evidence ID list after checking existence in the current in-memory repository. It does not prove that the evidence belongs to the same tenant, execution, mission, task, or verification request.
4. The legacy scoped state repository lists global entity collections and filters tenant scope in application memory. Its update/delete paths perform a scoped read followed by an unscoped mutation, with no expected-version argument.
5. The newer async tenant repository, async state-store facade, `AsyncEvidenceService`, and `AsyncVerificationService` are implemented as tenant-scoped application contracts. The current legacy `HappyOrchestrationEngine` constructor still uses the synchronous JSON-file state and in-memory evidence path; it does not yet compose these async services.
6. The async evidence and verification services persist evidence, registered verification requests, and verification results through separate tenant entity types. Verification loads the registered request from the tenant repository, checks exact mission/task/execution and evidence provenance, and keeps semantic outcome at `PARTIAL` while a capability-specific semantic verifier is unavailable.
7. Both async service lifecycles execute their related reads/writes inside the async state-store transaction callback. This establishes the adapter transaction boundary, but the in-memory adapter is explicitly test-only and does not provide PostgreSQL isolation. The PostgreSQL adapter and SQL schema/RPC remain deployment-gated; the schema candidate has not been applied to the connected Supabase project.
8. The async contracts have dedicated tenant isolation, evidence provenance, verification lifecycle, and persistence tests. Passing these tests does not mean the legacy orchestration path has been migrated or that production durable evidence is active.

## Required safe migration sequence

1. Define tenant-scoped evidence records with immutable provenance: organization, workspace, principal, mission, task, execution, verification request, evidence type/source, capture time, and content/object checksum.
2. Define an authenticated server identity and canonical tenant resolver before constructing any production repository. Never accept tenant identity solely from request JSON.
3. Design the PostgreSQL schema, constraints, indexes, grants, RLS policies, object-storage access rules, retention, backup/restore, and rollback as a reviewed migration candidate. Do not apply it to the connected production project as part of this work.
4. Implement a PostgreSQL adapter with storage-enforced scope predicates and transactionally enforced relationships. Verify using real authenticated user roles and RLS, not a service-role bypass.
5. Make evidence creation append-only and idempotency-aware. Bind evidence to the exact execution/verification scope and reject cross-tenant or cross-task evidence references.
6. Implement durable verification-request/result persistence and capability-specific verifiers. Preserve `PARTIAL` / `NOT_YET_CONNECTED` when no semantic verifier exists; do not upgrade evidence presence into outcome success.
7. Integrate the async evidence and verification stores into orchestration only after isolated PostgreSQL integration tests prove tenant isolation, rollback, duplicate handling, concurrent writes, and restart/worker visibility.
8. Keep the legacy file-backed path explicitly labelled local/single-host and do not advertise it as transactional multi-instance durability.

## Explicit non-actions

No production database writes, migrations, service-role bypass, deployment, merge, or changes to `main` were performed for this review.

## Mission crash-recovery boundary (2026-11-20)

A focused read of `src/core/orchestration/engine.ts` shows that the current mission loop persists a task as `RUNNING`, then creates its execution record, then calls the execution adapter, and only afterward persists the result and verification/evidence records. These are separate repository operations on the legacy synchronous state path; they are not one atomic transaction.

This leaves two materially different crash windows:

1. **Before dispatch:** the task can remain `RUNNING` without a durable execution request/result. A recovery worker cannot safely assume that work began.
2. **After dispatch, before result persistence:** an external side effect may have occurred while the persisted execution record still looks incomplete. Blindly replaying the task can duplicate the side effect.

The deterministic execution ID (`exec-${request.id}-${task.id}`) is useful for correlation, but a unique record ID alone is not an atomic claim, an outbox, or proof that an external adapter did not execute. The current `ExecutionRequest` contract has no idempotency key, lease owner, lease expiry, attempt identity, or fencing token. The current task status and retry counter therefore do not establish crash-safe execution ownership.

### Required durable recovery contract before enabling a worker

A future durable mission scheduler must implement all of the following at the storage boundary, under the authenticated tenant transaction:

- **Atomic claim:** conditionally claim one eligible task only if its persisted status and dependency snapshot permit execution; persist owner, lease expiry, attempt number, and monotonically increasing fencing token in the same transaction.
- **Fenced heartbeat and completion:** renew or finalize only when task ID, owner, attempt, and fencing token still match. An expired worker must not overwrite a newer owner's state.
- **Transactional dispatch intent:** persist the exact execution request and an outbox/dispatch record atomically with the claim. Dispatchers may redeliver the same intent, never manufacture a new logical execution on recovery.
- **Stable idempotency binding:** derive a non-secret idempotency key from tenant + mission + task + logical attempt + capability/action binding. Persist and validate the full binding; reject key reuse with a different payload or target.
- **Adapter-level deduplication:** require each side-effecting adapter to honor the idempotency key at the external boundary where possible. If the downstream system cannot deduplicate or report operation status, an ambiguous post-dispatch crash must enter reconciliation/manual-review state, not automatic replay.
- **Explicit recovery states:** distinguish never-dispatched work from dispatched-but-unconfirmed work. Reconcile execution status and evidence before retrying; preserve approval and verification gates.
- **Bounded retry policy:** retry only classified transient failures, enforce the persisted attempt limit and backoff, and never retry terminal, cancelled, approval-blocked, or semantically unverified work automatically.
- **Auditability:** append claim, heartbeat, dispatch, result, lease-expiry, reconciliation, retry, and terminal-transition events with exact tenant and attempt provenance.

### Safe implementation status

The current work does **not** add a worker, lease, outbox, or claim that crash recovery is active. Those capabilities require a transactional durable adapter and a schema with uniqueness/conditional-update constraints. The existing PostgreSQL tenant adapter is a persistence primitive, but the production provider is not composed into orchestration and the SQL schema candidate remains unapplied. The legacy orchestration path must remain explicitly non-crash-safe until the above contract is implemented and tested with concurrent workers, process restart, lease expiry, and an adapter-side-effect ambiguity harness.

A separate correctness hardening in this change rejects duplicate task IDs in `retryMissionTask`, matching the existing exact-identity guard on task status transitions. This prevents retrying an arbitrary first match from an ambiguous in-memory snapshot; it does not substitute for durable concurrency control.

### Mission snapshot integrity

Mission task transitions and retries now require the supplied task collection to match `mission.taskIds` exactly: declared IDs must be unique, every declared task must appear once, and no task from another mission or undeclared extra task may be included. This prevents a partial or widened caller-supplied snapshot from corrupting progress totals or causing a mission to be reported complete while declared work is missing. This is an in-memory input-integrity guard; it does not replace database constraints, version checks, or atomic writes.

### Mission-level execution gate

A task transition to `RUNNING` is now rejected unless its parent mission is in an executable state (`READY`, `RUNNING`, or `VERIFYING`). This closes a separate bypass where a caller could supply a still-pending task from a mission in `WAITING_APPROVAL`, `CANCELLED`, `FAILED`, or `BLOCKED` and start it directly. Retry remains an explicit operation that restores the failed mission/task to a retryable state; it does not grant a cancelled or approval-waiting mission permission to execute. Regression coverage exercises each denied mission state.

This remains a state-machine guard over the supplied snapshot. It does not replace a persisted approval decision, atomic compare-and-swap, or transactionally enforced mission/task lifecycle at the durable storage boundary.

Retry follows the same mission-level control boundary: `retryMissionTask` now accepts retries only when the parent mission is `FAILED` or `BLOCKED`. It rejects `WAITING_APPROVAL`, `CANCELLED`, `COMPLETED`, and `READY` missions, preventing a task-level retry from silently reviving a cancelled mission or bypassing a pending approval. Tests cover these rejected states. This is still an in-memory domain guard; durable mission status and retry admission must ultimately be checked atomically by the persistence/scheduler transaction.

The trusted approval path preserves the execution plan's `WAITING_APPROVAL` history for audit, but after `PipelineApprovalVerifier` confirms the persisted approval, orchestration now seeds the new mission as `READY`. This is necessary because the mission engine independently rejects task starts while a mission remains approval-pending. Unverified approval still returns before mission creation/execution; caller-supplied approval flags do not alter this boundary.


### Ready-task selection input validation (2026-11-20)

The task graph builder validates graph structure, but the ready-task selector also accepts a `TaskGraph` object directly. A caller could therefore bypass builder validation by supplying a hand-constructed graph with duplicate task IDs, missing dependencies, cycles, cross-mission task identities, or a graph-level mission ID that does not match its task snapshot. `getReadyTasks` now revalidates task membership/dependencies/cycles and checks the graph mission ID before returning executable candidates. Regression tests cover duplicate identity, missing dependency, and graph/task mission-ID mismatch. This is a scheduling-input integrity guard only; it does not provide atomic claims, leases, or cross-worker exclusion.


### Direct mission transition graph validation (2026-11-20)

The mission status-transition and retry APIs now independently rebuild/validate the supplied task graph after checking exact mission snapshot membership. This prevents callers from bypassing graph validation by invoking `MissionEngine.updateTaskStatus` or `retryMissionTask` directly with duplicate dependencies, missing dependencies, or dependency cycles. Regression cases cover each malformed graph at the direct transition boundary. This remains in-memory validation; it does not replace atomic persistence, version checks, or durable scheduler claims.


### Read-only mission crash-recovery assessment — 2026-11-21

Added `src/core/mission/recovery-assessment.ts` as a deterministic, read-only classifier for active mission tasks, scoped by mission/task identity (the current domain objects do not themselves carry tenant scope). It requires an exact mission/task snapshot and rejects execution records from another mission or task. For active RUNNING/VERIFYING tasks it distinguishes: missing execution record (reconciliation required), duplicate records (ambiguous/reconciliation required), unknown or still-running execution outcome (never blindly replay), completed execution (resume verification), approval wait, failed execution review, and blocked/not-connected review. Non-active tasks are left unchanged.

Regression coverage verifies missing, in-flight, completed, duplicate, and foreign execution records. The assessment performs no writes, retries, dispatches, or state transitions. It is a safety/reconciliation primitive only: it does not prove external side effects, establish durable leases/fencing/idempotency, or make the legacy JSON orchestration crash-safe. Production use still requires a transactional scheduler, durable execution identity, adapter-side idempotency, and explicit reconciliation evidence.

## Durable scheduler lease and dispatch contract (2026-11-21)

The domain boundary now exposes a pure contract in `src/core/mission/durable-scheduler-contract.ts`:

- A lease binds the complete organization/workspace/user scope, mission, task, owner, logical attempt, monotonically increasing fencing token, and expiry.
- Protected mutations compare a presented lease with the latest persisted lease. Owner/lease/attempt/scope mismatch is rejected; a stale fencing token and expired lease are rejected.
- A dispatch intent binds the same tenant, mission, task, and attempt to the execution request capability/action, with an idempotency key and canonical payload digest.
- Regression tests cover stale fencing tokens, owner/tenant mismatch, expiry, and dispatch-binding mismatch. The test is included in `test:security`.

This is a validation contract, not a scheduler implementation. The pure validator cannot close a read/write race. A production adapter must lock/CAS the current lease row, enforce fencing at the write boundary, insert the dispatch intent, and update task state in one authenticated tenant transaction. It must enforce unique `(tenant scope, idempotency key)` and immutable intent binding, then pass that key to an adapter that actually deduplicates side effects. No durable worker, automatic replay, or production persistence activation is introduced by this change.

### Dispatch request integrity hardening (2026-11-21)

The pure dispatch validator now binds an outbox intent to the exact execution request ID, a deterministic tenant/mission/task/logical-attempt/capability/action idempotency key, and a canonical SHA-256 digest of the complete immutable request fields. Canonical JSON sorts object keys, preserves array order, and rejects non-JSON values, non-plain objects, and cycles. Regression tests cover request-ID substitution, idempotency-key reuse, payload-digest substitution, malformed digest values, and equivalent object-key ordering.

This is still a validation primitive, not an outbox implementation. A durable adapter must persist the intent and task/lease transition atomically, enforce a unique constraint on the tenant-scoped idempotency key, make the stored binding immutable, and require downstream adapters to deduplicate side effects. A caller that can replace both the request and its digest is not constrained by this helper alone; trusted request construction and storage-boundary enforcement remain mandatory. No worker, DB schema, or production integration is activated by this change.


## Durable mission lease and transactional outbox candidate (2026-11-21)

Added design-only SQL candidate `supabase/drafts/20261121_durable_mission_scheduler_candidate.sql` and extended the disposable PostgreSQL tenant integration harness to exercise it. The candidate is deliberately not a migration and is not applied to any connected Supabase project.

The candidate introduces two private-by-privilege tables:
- `happy_mission_task_leases`, keyed by complete organization/workspace/user/mission/task scope, with lease ID, worker owner, attempt, monotonically increasing fencing token, and expiry.
- `happy_execution_dispatch_outbox`, with tenant-scoped unique idempotency key and unique execution request ID, immutable lease/attempt binding, payload digest, JSON payload, and explicit dispatch/reconciliation statuses.

The authenticated claim RPC uses the tenant membership lock helper, locks the mission and task rows, verifies mission membership and READY status, and checks every declared dependency resolves to a same-mission COMPLETED task. It changes the task to RUNNING and creates/renews the lease in one PostgreSQL transaction. An expired lease can be reclaimed only when no outbox intent exists for that lease. If an outbox row exists, the outcome may already be in flight or have occurred; the task is held for reconciliation rather than replayed. Reclaim increments both attempt and fencing token. The enqueue RPC locks the current lease, checks owner/token/expiry and exact request ID/mission/task/capability/action binding, and inserts an immutable outbox row under unique tenant-scoped keys. Exact duplicate requests return the original row; changed payload reuse is rejected.

The disposable integration harness now covers dependency gating, initial lease identity, active lease non-steal, identical outbox deduplication, idempotency-key payload mismatch, no automatic replay after an expired lease with an outbox row, safe reclaim when no outbox row exists, fencing-token advancement, stale-worker rejection, and direct table/service-role privilege denial.

Important boundaries:
- This is a database contract candidate, not a production adapter or worker. No outbox poller, provider dispatch, heartbeat, fenced completion, or external adapter-side idempotency is active.
- The candidate's caller-supplied payload digest is format-checked and stored immutably, but the SQL function does not independently recompute the TypeScript canonical JSON digest. A production adapter must verify the digest at a trusted boundary or standardize one canonical digest implementation across TypeScript and PostgreSQL.
- The idempotency key is unique per tenant, and request ID is independently unique per tenant; the database does not independently regenerate the SHA-256 key.
- Outbox payload encryption/redaction, size limits, retention, function ownership, private-schema grants, real Supabase JWT/RLS behavior, and hosted concurrency remain deployment gates.
- The harness uses a disposable PostgreSQL database with a local `auth.uid()` claim stub. It does not prove hosted Supabase identity or production migration compatibility.
- No production database writes, migrations, merge, or deployment were performed.


### Lease heartbeat and one-time outbox claim extension

The scheduler SQL candidate now also includes:
- `happy_heartbeat_mission_task_lease`: extends only a currently unexpired lease whose tenant scope, mission/task, lease ID, owner, and fencing token all match; bounded duration is 5–300 seconds.
- `happy_claim_dispatch_outbox`: verifies the current lease, then transitions a matching outbox row from PENDING to DISPATCHED exactly once and returns the immutable dispatch payload. Repeated claims are rejected for reconciliation rather than automatically replayed.
- Lock ordering is explicitly lease → outbox for enqueue and outbox claim (the claim first performs a non-locking lookup to discover the task binding), avoiding lease/outbox lock inversion.

The disposable PostgreSQL integration harness covers heartbeat extension, stale heartbeat rejection, one-time outbox claim, duplicate claim rejection, and the no-replay rule after a dispatch intent exists. A crash after PENDING → DISPATCHED is intentionally treated as ambiguous; a future worker must reconcile the external provider outcome and use provider-side idempotency. There is no automatic retry or worker loop.


### Provider outcome persistence boundary

The scheduler candidate now stores a JSON object outcome on each outbox row and exposes `happy_record_dispatch_outcome`. The authenticated RPC derives the actor from `auth.uid()`, checks active tenant scope, locks the current lease before the outbox, and requires exact lease ID, owner, fencing token, mission/task binding, and a current DISPATCHED status. It permits one terminal provider observation: ACKNOWLEDGED, AMBIGUOUS, FAILED, or RECONCILIATION_REQUIRED. A second result cannot overwrite the first.

An ACKNOWLEDGED provider response is deliberately not a task completion. The task remains RUNNING pending the separate semantic verification/evidence lifecycle. AMBIGUOUS is persisted as an explicit no-blind-retry state. The disposable PostgreSQL integration harness tests acknowledged outcome persistence, duplicate outcome rejection, and ambiguous outcome retention.

This still does not implement a real provider worker, authenticated provider credential boundary, provider-side idempotency, payload/result redaction or encryption, outcome schema validation per capability, or automatic reconciliation. The outcome JSON is currently an opaque object and must be normalized/validated by a trusted provider adapter before production use.


### Provider dispatch worker contract boundary (2026-11-21)

Added `src/core/mission/durable-dispatch-worker-contract.ts` and its regression test. This is a provider-neutral coordinator for an already-claimed outbox item, not a polling worker or production adapter.

- It validates the immutable request ID, outbox identity, lease ID, owner, and positive fencing token before any provider call.
- It refuses providers that do not explicitly guarantee idempotency-key deduplication. The stable outbox idempotency key is passed to the provider.
- A provider acknowledgement is persisted as ACKNOWLEDGED only when provider identity and provider request ID are present.
- A definitive provider rejection is persisted as FAILED.
- A thrown transport error is treated as AMBIGUOUS because the remote side effect may already have occurred; it is never interpreted as proof of non-execution.
- Outcome persistence is attempted once. If it fails, the coordinator returns OUTCOME_PERSISTENCE_FAILED and does not call the provider again from that invocation; the DISPATCHED outbox item requires reconciliation.
- ACKNOWLEDGED still does not complete a mission task; verification and evidence remain separate gates.

Regression tests cover idempotency-key forwarding, refusal of non-idempotent providers before invocation, transport ambiguity, mismatched request rejection, and no provider replay when outcome persistence fails. The test is included in `test:security`.

Remaining limitations: no durable outbox poller/worker lifecycle, provider credential vault, concrete provider implementation, provider status-query reconciliation, hosted Supabase integration, or task completion/verification composition is activated. The SQL candidate remains design-only and no production database, merge, or deployment changes were made.
