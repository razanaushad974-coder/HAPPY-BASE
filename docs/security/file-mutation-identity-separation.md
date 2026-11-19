# FILE approval identity separation contract

**Status:** architecture decision / implementation requirement. This document does not enable FILE operations and does not authorize a database migration.

## Decision

Requester, approver, and executor are three distinct security principals. They must not be inferred from one another, and none may be supplied as an authorization claim by an untrusted request body.

| Principal | Trusted source | Required checks |
|---|---|---|
| Requester | Durable server-owned execution request / task record | Exact request, task, mission, tenant, and request ownership binding |
| Approver | Persisted approval decision / grant row | Decision was made by this user; current active organization and workspace membership; current FOUNDER or ADMIN role |
| Executor | Current server-validated session | Current active organization and workspace membership; matches the grant's explicit executor policy |

The current ExecutionRequest object is not itself proof of requester identity. The eventual context provider must load the authoritative request record and verify that its requester, request/task/mission identifiers, and tenant scope match the execution being authorized.

## Executor policy

For the first implementation, use a **named-executor** policy:
- The approval decision records one immutable executor_user_id.
- At consumption, the current authenticated session user must equal that exact executor.
- The executor must independently have active membership in the same organization and workspace.
- The requester may differ from both executor and approver.
- The approver may differ from both requester and executor.
- Do not introduce a workspace-wide or any-member executor policy in this phase. That is a broader delegation model and requires separate threat analysis.

This avoids accidentally turning an approval for one agent/session into a bearer capability usable by every tenant member.

## Required authorization sequence

1. Read the executor from the validated server session; never from JSON, user_metadata, or a client-supplied actor object.
2. Resolve the requested organization/workspace against authoritative active membership records for that executor.
3. Load the durable execution request and derive its requester from server-owned state. Confirm request/task/mission and tenant scope.
4. Load the approved grant using the immutable operation binding, including the named executor. The approver ID comes from the persisted grant, not from the executor session.
5. Resolve the grant's approver independently against authoritative active organization/workspace membership records. Require exact user/org/workspace matches.
6. Re-check the approver's current required role (FOUNDER or ADMIN) in that same scope. A role or membership revoked after approval must invalidate execution.
7. Compare every grant binding: request/task/mission, requester, named executor, approver, organization/workspace, FILE target, operation, source/destination paths, and SHA-256 digest of the normalized operation including content and expected prior-content hash.
8. Atomically consume the exact approved grant with a single conditional database transition. A replay, concurrent second consumer, expiry, revocation, or any mismatch must fail.
9. Only after successful consumption may the trusted FILE execution path proceed. Any identity, membership, role, store, or parsing error fails closed.

## Grant/store contract changes required

- Add immutable executor_user_id to the grant.
- Grant lookup must not assume the approver is the current executor. It may locate a candidate using request, task, mission, requester, executor, tenant, target, operation, paths, and digest; after loading, the verifier must validate the persisted approver independently.
- The atomic consume predicate must include approver_user_id and executor_user_id as well as every other immutable binding field.
- The approver membership resolver must be separate from the executor session provider. It must query authoritative membership state; constructing an actor object from a grant ID alone is not membership proof.
- The approval decision workflow must persist the actual approver and the intended named executor. Neither identity may be mutable after approval; changing either requires a new approval.
- Keep service-role/database access server-only. Since service-role access bypasses RLS, every store query and mutation must carry exact tenant predicates and validate the returned row.

## Mandatory regression cases

- Three distinct identities: requester A, approver B, executor C — allowed only when all exact bindings and current membership/role checks pass.
- Requester equals executor, approver differs — allowed when explicitly named.
- Requester equals approver, executor differs — allowed when explicitly named.
- Executor differs from the grant's named executor — denied before consumption.
- Approver missing, suspended, revoked, in another tenant, or no longer FOUNDER/ADMIN — denied before consumption.
- Executor missing, suspended, revoked, or in another tenant — denied before consumption.
- Client-supplied requester/approver/executor identity or role claims — ignored; server-owned values win.
- Request/task/mission/tenant/target/action/path/destination/content/hash mismatch — denied.
- Expired, revoked, already-consumed, or replayed grant — denied.
- Two concurrent executions — exactly one atomic consume succeeds.
- Membership resolver, role authorizer, request store, or grant store failure — denied.

## Current implementation boundary

The existing verifier still implements same-actor approval/execution. This contract is a design milestone only: it does not change that behavior, add a Supabase membership resolver, add a durable grant-store adapter, or enable FILE READ/mutations. The FILE adapter remains default-deny unless a trusted server-side authorizer is explicitly composed. Do not apply SQL, deploy, or merge based on this document.


## Self-approval policy reconciliation (2026-11-19)

**Authoritative rule: requester self-approval is prohibited.** This overrides the earlier illustrative regression-case bullet that listed requester-equals-approver as an allowed scenario. The requester may equal the named executor, but must not equal the approver. Enforce this in both the verifier and a database CHECK constraint before any membership lookup or grant consumption.
