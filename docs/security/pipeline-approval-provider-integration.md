# Pipeline approval provider integration

The core approval boundary is implemented in `src/core/approval/pipeline-approval-verifier.ts`. It intentionally does not invent an authentication provider or persistence backend.

## Required server adapters

The application must provide all three dependencies:

1. **ApprovalSessionProvider** — read the authenticated actor from a server-validated session/cookie/token. Never accept `authenticatedActorUserId`, role, organization membership, or workspace membership from request JSON.
2. **PersistedPipelineApprovalStore** — read approval requests from the durable database using organization/workspace scope. Implement `approveIfPending` as one atomic conditional update (status must still be `PENDING`). A read-then-write without a database condition/transaction is not sufficient.
3. **ApprovalRoleAuthorizer** — resolve the actor's current role from trusted membership/authorization data for the exact organization and workspace. Do not trust a role string stored in the browser or supplied by the requester.

## Approval record contract

A pending record must bind all of these fields: `requestId`, `planId`, `organizationId`, `workspaceId`, `requesterUserId`, `requiredRole`, `status`, and `expiresAt`.

When approved, the atomic store operation must persist `approverUserId` and `decidedAt` while changing only `PENDING` to `APPROVED`. Repeated or concurrent decisions must fail closed.

## Request flow

1. The server route obtains its actor and tenant scope from the validated session.
2. The route calls `PipelineApprovalDecisionService.approve`; the service reloads the pending record, checks request/plan/tenant/requester binding, expiry, and current role, then requests an atomic approval update.
3. The pipeline is invoked with a `TrustedPipelineExecutionContext` built by the server from that same validated session.
4. `PersistedPipelineApprovalVerifier` independently reloads the record and verifies that the persisted approver is the authenticated actor, the record is approved and unexpired, all identifiers match, and the actor still has the required role.
5. Only a successful verifier result reaches the downstream execution request. Missing adapters, missing session, storage errors, role failures, stale writes, and mismatches all return false.

## Not yet connected

The repository currently has no configured authentication provider, durable approval-store adapter, role/membership adapter, or approval API route. Therefore these core services are reusable server-side boundaries, not a live connected approval feature. High-risk execution remains blocked until those adapters are implemented and wired in. Do not use the in-memory test doubles as production adapters.
