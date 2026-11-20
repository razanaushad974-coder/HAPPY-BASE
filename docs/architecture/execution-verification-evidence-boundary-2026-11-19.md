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
