# Authenticated execution request boundary — 2026-11-21

## Implemented on the development branch

- `POST /api/execution/requests` accepts a bounded JSON intent, requires an exact same-origin request, an idempotency key, a server-created Supabase SSR client, verified Supabase user identity, and an active membership in the exact organization/workspace pair.
- The route generates the request ID. The client cannot set requester/executor IDs, risk, approval requirement, approval status, approval role, or execution status.
- The database creation RPC derives requester and executor from `auth.uid()`, checks active organization/workspace membership, persists the immutable capability/action/input/optional target reference, and computes an input SHA-256 digest.
- Every new request is forced to `HIGH` risk, `requires_approval=true`, `approval_status=PENDING`, `required_approval_role=FOUNDER`, and `status=WAITING_APPROVAL`. There is no caller-controlled approval bypass in the RPC signature.
- `POST /api/execution/requests/[requestId]/decision` delegates the decision to a transactionally scoped RPC. PostgreSQL derives the approver from `auth.uid()`, locks the tenant/request/membership rows, requires active FOUNDER organization membership and exact active workspace membership, and forbids self-approval. Approval moves the request to `READY`; rejection moves it to `CANCELLED`.
- The durable request resolver returns the full immutable execution envelope only to the assigned executor. The TypeScript store validates the envelope, digest, risk, approval state, required role, and lifecycle state. Idempotency retries return the original request even if its approval state has since advanced; reusing a key for different intent is rejected.
- Both endpoints return `Cache-Control: private, no-store`. Neither endpoint dispatches work. The response explicitly says `dispatch=NOT_DISPATCHED`.

## Verification harness

- `scripts/security/postgres-execution-request-approval-integration.sh` applies the design candidates to a disposable PostgreSQL database and checks forced founder approval, exact executor lookup, non-executor denial, idempotent create/retry behavior, no self-approval, non-founder denial, founder approval/rejection, membership revocation, and direct DML/pre-approved insert bypass attempts.
- `.github/workflows/postgres-security-integration.yml` runs this harness in CI. A CI pass is isolated PostgreSQL contract evidence, not proof of hosted Supabase JWT/RLS/function-owner behavior.

## Database candidate status

The SQL is a design-only candidate at:

- `supabase/drafts/20261121_authenticated_execution_envelope_candidate.sql`

It depends on the identity/request tables and authenticated membership/request resolver candidates:

- `20261119_file_mutation_atomic_consume_candidate.sql`
- `20261121_authenticated_execution_request_rpc_candidate.sql`

It has **not** been applied to any Supabase project. Before applying, reconcile existing schema ownership, role creation privileges, the installed pgcrypto schema/function, existing status constraints, function ownership, and migration ordering. Review the complete SQL against a disposable PostgreSQL/Supabase-compatible environment first.

## Explicit remaining blockers

- The approval decision RPC currently transitions an approved request to `READY`; it does not claim or dispatch it.
- There is no atomic `READY → RUNNING` worker claim/fencing RPC in this change.
- There is no durable outcome/evidence transaction or crash/ambiguous-dispatch reconciliation in this change.
- No production execution adapter is activated by this route. Existing default adapters remain `NOT_YET_CONNECTED`.
- All capabilities are conservatively assigned HIGH risk and FOUNDER approval. A future server-side capability/action policy may refine this only after policy and authorization tests exist; client fields must never control risk or approval.
- Self-execution only is supported. Delegated execution needs a separately reviewed executor assignment and authorization policy.
- Route code and SQL candidate are branch-level work only; CI must pass before considering the implementation verified. No production deployment, hosted migration, or main-branch change is authorized by this work.
