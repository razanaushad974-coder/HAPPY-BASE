# Execution request envelope and approval lifecycle — 2026-11-21

## Implemented on the development branch

- `SupabaseDurableExecutionRequestCreator` creates a server-side immutable envelope through `create_authenticated_execution_request`.
- PostgreSQL computes the SHA-256 digest of the JSONB input payload. Idempotency is bound to the full envelope (task, mission, capability, action, input, target reference, risk/approval policy) so a retry with a fresh proposed request ID resolves to the original durable request.
- PostgreSQL derives requester and executor from `auth.uid()`; this path supports self-execution only. Delegated execution is not enabled.
- The database fixes the request to `risk=HIGH`, `requires_approval=true`, and `required_approval_role=FOUNDER`. The caller cannot choose these fields or the requester/executor identity.
- Creation checks the exact active organization/workspace and membership rows while holding share locks, and enforces a scope-bound idempotency key. Reuse with a different envelope is rejected.
- `resolve_authenticated_execution_request` returns the full persisted envelope only to the assigned executor. The TypeScript store validates every required field and fails closed on malformed rows or RPC errors.
- `decide_authenticated_execution_request` permits only a different active FOUNDER with active workspace membership to decide a pending request. Decision, approver identity, timestamp, reason, status transition, and append-only approval evidence are committed atomically.
- The API routes persist intent and approve/reject intent only. The response explicitly reports `dispatch: NOT_DISPATCHED`.

## Deliberately not implemented / production gates

1. The SQL remains a design-only candidate. It has not been applied to hosted Supabase. Function ownership, grants, RLS/FORCE RLS, migration ordering, and actual Supabase JWT behavior require review and integration testing.
2. No claim/dispatch RPC is exposed. Approval moves a request to `READY`, but does not execute it. Do not infer that approval equals execution.
3. The API currently accepts task and mission IDs as selectors. It does not yet prove that those IDs resolve to canonical persisted TASK/MISSION records in the same tenant. Add that binding before any worker/dispatch path is enabled.
4. There is no trusted durable tenant workspace volume/worker composition wired into the execution engine. Keep execution adapters disconnected until that boundary is provisioned and verified.
5. Delegated executor assignment, multi-stage approvals, non-founder approval policies, cancellation after approval, lease/fencing, provider dispatch reconciliation, and execution-result persistence remain separate future contracts.
6. An approved request is not a FILE mutation grant. FILE writes still require the separate exact-operation, approver-bound, atomic-consume grant path.

## Required verification before enabling dispatch

- Apply only after the candidate SQL is reconciled with the actual schema and reviewed by a database owner.
- Test create idempotency (same key/same envelope; same key/different envelope), cross-tenant denial, inactive/revoked membership, self-approval denial, non-founder denial, concurrent double-decision, append-only evidence, and stale request IDs with real user JWTs.
- Verify the RPC owner roles are NOLOGIN/BYPASSRLS with only the listed table privileges and no service-role ownership.
- Verify persisted task/mission binding and workspace-volume identity before any executor can claim work.
- Keep API/Browser egress and FILE workspace execution unavailable until their separate security boundaries are in place.
