# HAPPY transactional runtime persistence — implementation decision

**Date:** 2026-11-19  
**Status:** Architecture decision; implementation gate, not a migration  
**Target branch:** `platform/full-happy-audit-and-integration`

## Decision

HAPPY will not bolt a Supabase client onto the current synchronous `PersistenceService`. The existing abstraction is not capable of providing the guarantees required by a multi-instance orchestration runtime.

The current implementation has these concrete properties:

- `PersistentStateAdapter.load(): HappyState` and `save(state): void` are synchronous.
- `PersistenceService` eagerly loads one complete process-local `HappyState`, mutates arrays in memory, then rewrites the whole JSON document.
- `ScopedStateRepository` exposes Promise-returning methods but calls the synchronous service internally.
- The persisted record envelope contains tenant identifiers inside `data`, not in a database-enforced composite key.
- Two server processes can load the same file snapshot and overwrite one another; record version increments are local and are not compare-and-swap protection.
- A remote Supabase call cannot satisfy this contract honestly without blocking I/O or maintaining a stale local cache. Neither is acceptable as the production runtime store.

## Non-negotiable invariants

1. **No sync facade over network I/O.** Durable remote persistence is asynchronous from the public application boundary through the adapter.
2. **Tenant scope is first-class.** Every read, write, list, and delete carries the verified `organizationId`, `workspaceId`, and authenticated `userId` scope. Scope is never accepted as authorization merely because it appears in a request body.
3. **Atomic concurrency.** Updates require an expected version and return a conflict when the stored version differs. A read-then-write sequence is not a substitute for a database conditional write.
4. **No whole-state replacement for routine mutations.** Persist entity records and lifecycle transitions at the smallest atomic boundary. Whole-snapshot persistence remains a compatibility/import/export concern only.
5. **No silent fallback.** If the durable provider is configured but unavailable, the operation fails closed. It must not silently fall back to memory or local files.
6. **Audit and evidence are durable.** Mission/task transitions, approvals, executions, verification results, evidence references, and audit events must share tenant scope and preserve provenance.
7. **Approvals are independent authority records.** A snapshot version or caller-provided approval flag cannot authorize execution. Approval decisions remain exact-binding, persisted, and independently revalidated.
8. **Schema is not assumed.** The existing connected Supabase project had no confirmed HAPPY application tables/migration history in the prior read-only baseline. No table, schema, RPC, or RLS policy is assumed to exist.

## Target application contract

The first refactor introduces an asynchronous persistence boundary. It must be implemented without breaking the existing JSON-file test adapter until all production composition points have migrated.

The target contract is entity-oriented and tenant-scoped:

- `get(scope, entityType, id)`
- `list(scope, entityType, query)`
- `create(scope, entityType, id, data)`
- `update(scope, entityType, id, expectedVersion, data)`
- `delete(scope, entityType, id, expectedVersion)`

All methods return Promises. Create must reject duplicate IDs within the tenant/entity namespace. Update/delete must use a single conditional database mutation keyed by tenant scope, entity type, record ID, and expected version. A zero-row mutation is a typed not-found/version-conflict result, not success.

The repository layer must continue to enforce the existing user-principal invariant before calling the adapter. The database layer must independently enforce tenant keys, foreign keys, and RLS/authorization. Application filtering after loading cross-tenant rows is not an acceptable isolation boundary.

## Supabase implementation requirements

A production Supabase adapter is permitted only after the following are designed and tested together:

- A canonical tenant schema and a read-only legacy-ID mapping inventory. UUID assumptions must not be retrofitted onto legacy identifiers without an approved mapping.
- Tenant tables with organization/workspace composite relationships and explicit user ownership/principal fields.
- RLS enabled with policies based on verified `auth.uid()` and active organization/workspace membership; no client-supplied principal or role is authoritative.
- A narrowly scoped server-side adapter. Service-role credentials must never enter client bundles or be used to bypass tenant checks.
- Atomic conditional writes using expected versions; transaction/RPC boundaries for multi-record lifecycle transitions.
- Durable audit/evidence records and retention/deletion semantics.
- Disposable PostgreSQL integration tests for tenant isolation, concurrent writes, stale versions, missing principals, membership revocation, and rollback.
- Runtime composition that selects Supabase only when the required server configuration and verified session provider are present. Otherwise report `NOT_YET_CONNECTED` and deny durable execution.

The existing private-schema membership/grant adapters are useful structural patterns, but they do not constitute a general-purpose transactional runtime store. The FILE grant consume RPC is a separate authorization transaction and must not be repurposed as a generic persistence API.

## Migration sequence

### Phase A — inventory and boundary (current)

- Record the synchronous API mismatch and all state-model constraints.
- Enumerate every `PersistenceService` construction and consumer, including engine composition and route boundaries.
- Identify which operations require single-record atomicity and which require multi-record transactions.
- Keep JSON-file persistence as a local/test adapter only; do not label it production multi-instance durable storage.

### Phase B — async repository migration

- Introduce async adapter and repository contracts alongside the legacy interface.
- Migrate scoped repositories and orchestration call sites in bounded commits.
- Preserve JSON adapter behavior through an explicitly named local adapter.
- Add conformance tests that run against local test adapters and the disposable PostgreSQL implementation.
- Remove the synchronous runtime path only after all consumers are migrated.

### Phase C — database schema and adapter

- Finalize canonical schema and legacy mapping.
- Add reviewed, unapplied migrations and an async Supabase implementation.
- Test RLS and conditional-write semantics against disposable PostgreSQL, including concurrency.
- Keep provider registry at `NOT_YET_CONNECTED` until the real server composition and environment are configured and verified.

### Phase D — orchestration composition

- Inject the async tenant-scoped store into orchestration, approval, evidence, and audit services.
- Persist mission/task transitions and recovery checkpoints atomically.
- Add crash/restart, duplicate-delivery, retry, cancellation, and stale-worker tests.
- Enable runtime use only after the end-to-end authenticated route tests pass.

## Explicitly prohibited shortcuts

- Do not implement Supabase by synchronously loading a full database snapshot into process memory and saving it back wholesale.
- Do not use a service-role client as a substitute for user/session verification or RLS.
- Do not trust caller-supplied user, organization, or workspace IDs.
- Do not convert a missing table, network failure, or RLS denial into an empty state.
- Do not fall back from failed remote persistence to JSON or memory.
- Do not apply migrations, perform production writes, merge, or deploy as part of this architecture phase.

## Acceptance criteria

- [ ] All persistence consumers inventoried on the target branch.
- [ ] Async repository contract and typed conflict/not-found semantics implemented.
- [ ] Scoped repository passes authenticated tenant scope on every operation.
- [ ] No sync remote-I/O facade or process-local stale cache.
- [ ] JSON adapter remains clearly local/test-only.
- [ ] Disposable PostgreSQL tests prove tenant isolation and optimistic concurrency.
- [ ] Supabase provider remains `NOT_YET_CONNECTED` until real server composition is verified.
- [ ] Mission, approval, evidence, and audit transitions have explicit transaction boundaries.
- [ ] No production migration/write/deploy without separate explicit authorization.
