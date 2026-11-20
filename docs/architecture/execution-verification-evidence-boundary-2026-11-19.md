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
