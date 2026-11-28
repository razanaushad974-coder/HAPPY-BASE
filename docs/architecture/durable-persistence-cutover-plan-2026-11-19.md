# HAPPY durable persistence cutover — implementation findings and gate plan

**Date:** 2026-11-19  
**Branch:** `platform/full-happy-audit-and-integration`  
**Status:** Read-only source inspection completed; design gate only. No production database, schema, or runtime changes.

## Executive finding

The current orchestration path is not yet using the asynchronous tenant persistence contracts. The production-shaped engine constructor still creates a synchronous JSON-file adapter, and the evidence repository is process-memory-only. The newer async tenant repository, async memory service, and async state-store facade are useful contracts/tests, but they are not a production persistence cutover.

Do not register a Postgres/Supabase provider or claim multi-instance durability until a canonical schema, authenticated identity boundary, tenant membership rules, database-level compare-and-swap semantics, and real-role RLS tests exist.

## Verified source path inventory

| Component | Current implementation | Consequence |
|---|---|---|
| `src/core/orchestration/engine.ts` | Constructor defaults to `.happy-state/orchestration-state.json`, instantiates `JsonFileStateAdapter` and `PersistenceService`, then passes the same persistence instance into `createHappyStateStore` and `PersistentMemoryService`. | Main pipeline is still synchronous local-file persistence. Tenant scope is layered above the storage adapter rather than enforced by the database. |
| `src/core/persistence/adapters/json-file-adapter.ts` | `load()` uses synchronous file reads; `save()` serializes and writes the whole state file using `writeFileSync`. | No database transaction, cross-process lock, row-level isolation, atomic CAS, or multi-instance coordination is provided by this adapter. A successful local write is not proof of production durability. |
| `src/core/persistence/service.ts` | Holds one in-memory `HappyState`; create/get/list/update/delete/count/snapshot/reset operate synchronously on entity collections. Update increments a local version but accepts no expected version. | Version numbers are descriptive, not concurrency control. A process can overwrite another process's changes; update/delete are not atomic conditional operations. |
| `src/core/state/scoped-repository.ts` | Promise-returning facade over synchronous `PersistenceService`. `list()` reads the entire entity collection and filters tenant scope in application memory. `update()` and `delete()` perform a separate scoped read followed by unscoped storage mutation. | Async signatures do not make the backing store asynchronous or safe. Tenant filtering is not a storage boundary; check-then-write permits TOCTOU races and cross-scope ID collision hazards. |
| `src/core/memory/persistent-service.ts` | Uses the same synchronous persistence service when injected by orchestration; otherwise constructs another JSON-file persistence instance. | Memory is not yet wired to `AsyncPersistentMemoryService`; callers can create independent file-backed state instances. |
| `src/core/evidence/repository.ts` | `InMemoryEvidenceRepository` stores records in a process-local `Map`. | Evidence disappears on process restart and is not durable or queryable across workers/instances. |
| `src/core/evidence/service.ts` | Delegates capture/get/list operations to an injected `EvidenceRepository`. | The service boundary is suitable for adapter injection, but current engine composition selects the in-memory implementation. |
| `src/core/state/async-happy-state-store.ts` and `src/core/persistence/async-tenant-repository.ts` | Adapter-injected async repository facade with complete org/workspace/user scope and version-aware update/delete contracts. | Good target contract; no production Postgres adapter or orchestration composition is established by these files. |
| `src/core/persistence/provider-registry.ts` | Registry reports `FILE` as `AVAILABLE` and `durable: true`, while Postgres/Supabase remain `NOT_YET_CONNECTED`. | The generic `durable` flag is ambiguous: a local file can survive a process restart on one host, but does not provide transactional, tenant-isolated, multi-instance runtime durability. Product/API wording must distinguish local persistence from production-grade durability. |
| `src/core/state/types.ts` and `src/core/state/factory.ts` | Legacy `TenantScope.userId` is optional and `createTenantScope()` validates only organization/workspace; the async repository contract separately requires complete scope. | Do not reuse the legacy factory as proof of an authenticated principal. The production server boundary must provide a verified non-empty user ID before constructing the async store. |
| `src/core/persistence/adapters/in-memory-tenant-adapter.ts` | Deterministic in-memory adapter for tests/development. | Test adapter only; it is not a production substitute and its in-process behavior does not prove database atomicity. |

## Concrete correctness and security gaps to close

1. **Storage-enforced tenant scope:** every read/write/delete must include the validated organization, workspace, and principal scope in the database predicate or equivalent RLS policy. Never load all tenants and filter in application memory.
2. **Database-level CAS:** updates/deletes must be one conditional statement/transaction keyed by tenant scope, entity identity, and expected version. A read-then-write implementation is insufficient.
3. **Identity provenance:** production scope must be resolved from a verified server-side auth session and active membership, not request JSON or a caller-selected tenant ID.
4. **Lifecycle and authorization:** membership changes, approval state transitions, execution request ownership, and task/mission relationships need transactionally enforced rules.
5. **Evidence durability:** evidence metadata and provenance need durable tenant-scoped storage. Blob/object storage, if introduced, must bind immutable object identity/checksum to the evidence record and verify access independently.
6. **Multi-process behavior:** migrations must prove duplicate-create handling, concurrent CAS single-winner behavior, transaction rollback, and process/worker coordination against PostgreSQL.
7. **Provider truthfulness:** distinguish local single-host file persistence from transactional multi-instance durability; do not advertise the generic FILE `durable: true` flag as production durability.\n8. **Migration safety:** no production migration or adapter activation until schema ownership, grants, RLS policies, indexes, retention, backup/restore, and rollback are reviewed.

## Required production adapter contract

Implement a Postgres-backed `AsyncTenantPersistenceAdapter` only after the schema and auth boundary are reviewed. The adapter must:

- reject incomplete or malformed tenant scopes before issuing SQL;
- include organization, workspace, and user scope in every operation (entity-specific scope rules must be explicit, not silently widened);
- use parameterized SQL and database constraints for unique tenant/entity keys;
- implement update as a single conditional `UPDATE ... WHERE scope = ... AND version = expectedVersion RETURNING ...`;
- implement delete as a single conditional `DELETE ... WHERE scope = ... AND version = expectedVersion RETURNING ...`;
- distinguish not-found, duplicate, stale-version, invalid-scope, and disconnected-provider outcomes without leaking cross-tenant record existence;
- never fall back to JSON, process memory, service-role RLS bypass, or an assumed table/schema;
- keep transactions and lock ordering explicit for multi-record lifecycle operations;
- expose bounded timeouts and retry only transient errors where retry is safe and idempotent.

The generic entity envelope should not be assumed to be the final relational schema. Define entity-specific constraints and foreign keys for mission/task/execution/verification/evidence/approval relationships before implementing the adapter.

## Cutover sequence and exit gates

### Gate A — complete inventory (current task)
- Trace every construction site of `PersistenceService`, `JsonFileStateAdapter`, `PersistentMemoryService`, and `InMemoryEvidenceRepository`.
- Trace all state entity types and every caller that assumes synchronous snapshot/reset/list behavior.
- Identify tests that rely on filesystem persistence and preserve them as local-adapter tests rather than silently changing their semantics.

### Gate B — canonical schema and auth contract
- Define tenant, membership, entity, mission/task, execution, verification, evidence, approval, audit, and idempotency constraints.
- Define authenticated user → active organization/workspace membership → tenant scope resolution.
- Specify RLS policies and function ownership/grants; test with real authenticated roles/JWT claims, not a service-role bypass.
- Produce isolated PostgreSQL migrations and disposable-database integration tests only. Do not apply to the connected production project.

### Gate C — production adapter proof
- Implement Postgres adapter behind explicit injection; no automatic default-provider switch.
- Prove tenant isolation, unique constraints, true CAS, transaction rollback, concurrent writers, cancellation/retry/idempotency, and RLS denial with isolated PostgreSQL.
- Add contract tests shared by the in-memory and PostgreSQL adapters, while keeping DB concurrency tests as separate authoritative tests.

### Gate D — orchestration composition
- Make the engine receive an explicit persistence composition from a trusted server boundary.
- Replace the sync facade only after all callers and tests are migrated to awaited operations and version-aware writes.
- Persist evidence through a tenant-scoped durable repository.
- Ensure command, memory, mission, task, execution, verification, evidence, approval, and audit writes participate in explicit transactions where required.
- Preserve a local/test composition for CLI and tests; never let it masquerade as production.

### Gate E — operational readiness
- Verify migration/rollback, backups/restore, observability, retention, rate limits, connection pooling, availability, and recovery.
- Run end-to-end authenticated tenant tests and multi-instance tests.
- Only then propose production rollout; rollout still requires explicit owner approval.

## Explicit non-claims

- This inspection does not establish that the connected Supabase project has the required HAPPY application schema.
- It does not establish that the current async interfaces are wired to orchestration or backed by PostgreSQL.
- It does not establish production RLS correctness, multi-instance durability, or real-user JWT authorization.
- No production database writes, migrations, deployment, merge, or `main` branch changes were performed.
