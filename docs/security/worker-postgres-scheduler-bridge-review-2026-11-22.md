# Worker PostgreSQL scheduler bridge — 2026-11-22

## Added in this branch

The following code-level pieces now exist:

- `src/core/mission/postgres-worker-database-session.ts`: dedicated PostgreSQL LOGIN session boundary; verifies both `session_user` and `current_user`, bounds statement/idle-transaction timeouts, and uses one transaction per operation.
- `supabase/drafts/20261122_worker_principal_registry_candidate.sql`: operator-managed worker principal registry, tenant grants, RLS policies, and transactionally locked worker-to-user scope resolver.
- `supabase/drafts/20261122_worker_scheduler_rpc_candidate.sql`: worker-specific counterparts for task claim, dispatch enqueue, lease heartbeat, outbox claim, outcome recording, reconciliation evidence append, and evidence listing. They derive identity through the registry/scope helper and do not use `auth.uid()`.
- `src/core/mission/worker-database-broker.ts`: typed fixed-operation broker contract and tenant selector types.
- `src/core/mission/postgres-worker-database-broker.ts`: fixed SQL adapter that calls only the seven worker RPC names, binds all values, maps database rows to immutable typed results, and executes each operation inside the dedicated worker session provider.
- `src/tests/core/mission/postgres-worker-database-broker.test.ts`: fake-session contract coverage for all seven adapter operations and bound parameter counts.
- `scripts/security/worker-scheduler-draft-contract.sh`: static fail-closed checks that every worker RPC resolves tenant scope, avoids human JWT identity, is SECURITY DEFINER, and has no EXECUTE grant.

## Runtime composition boundary

- `src/core/mission/worker-runtime-composition.ts` is a fail-closed composition seam for the trusted identity resolver, live worker-principal registry, and fixed-operation database broker.
- `MissionOrchestrator.prepareWorkerRuntimeOperation` exposes the explicit seam; the default orchestrator remains `NOT_CONNECTED`, and existing in-memory mission/task creation is preserved.
- Composition returns a guarded broker facade, never the raw broker. Each of the seven fixed broker methods re-resolves workload identity and checks the authoritative principal registry immediately before invoking the underlying method. Disabled/revoked principals, registry outages, identity failures, and capability downgrades fail closed.
- `COMPOSITION_AVAILABLE` is deliberately not a connected/live status. It exposes `liveDatabaseSession: "NOT_VERIFIED"`; the actual dedicated PostgreSQL LOGIN session must still be proven by the broker's session provider.
- `src/tests/core/mission/worker-runtime-composition.test.ts` covers missing dependencies, successful composition without claiming a live DB session, disabled principal, capability denial, registry outage, forged identity rejection, expiry, and revocation between composition and a later broker call.
- This is a guarded authorization seam, not yet durable worker dispatch or a deployed worker process. Existing in-memory orchestration is not silently replaced.

## Critical authorization properties

- The worker principal UUID and user UUID passed by the adapter are selectors, not credentials. PostgreSQL derives the real worker from `session_user`.
- Each worker RPC invokes `happy_require_worker_tenant_scope` in the same transaction as its operation. That resolver checks the live principal registry, worker tenant grant, active organization/workspace, and active organization/workspace memberships under row locks.
- The existing human RPCs remain separate and continue using `auth.uid()`; worker RPCs do not set JWT GUCs or impersonate an authenticated human.
- The dispatch enqueue twin retains the original scheduler's persisted founder-approval, request/task/mission binding, payload digest, idempotency, and lease/fencing checks.
- Direct table access and worker RPC EXECUTE grants remain revoked in the draft.

## Not production-connected

This is not a claim that the worker runtime is live. The SQL is candidate-only and has not been applied. The PostgreSQL session provider and broker adapter are not wired to an actual dedicated worker pool or the HAPPY orchestration runtime. No actual Vercel workload credential source, role password/rotation, operator registration/revocation automation, or hosted Supabase pooler `session_user` verification exists. The test harness is local PostgreSQL only.

Before connecting:
1. Fix and pass the isolated PostgreSQL registry integration harness.
2. Review every candidate SQL dependency and exact function/table owner privilege on a disposable target-compatible PostgreSQL instance.
3. Verify hosted Supabase/pooler preserves the dedicated LOGIN principal end-to-end.
4. Provision the role and secret through an approved secure operator path; never through app code or a service-role key.
5. Apply migrations/grants only after explicit owner approval and adversarial tests.
6. Wire the adapter into the worker runtime with bounded retries, lease fencing, idempotency, outcome reconciliation and evidence persistence.
7. Verify tenant isolation, founder approval and stale-worker denial against live hosted services.

No production resource, migration, credential, grant, Vercel deployment, or hosted database was changed.
