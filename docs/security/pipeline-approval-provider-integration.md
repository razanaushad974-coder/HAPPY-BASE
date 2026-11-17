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


## Approval-level mapping and quorum safety

- `FOUNDER`, `ADMIN`, and `SECURITY` are supported single-approver role requirements by the core verifier contract. The authorization adapter must resolve each role from current trusted membership data in the exact tenant scope.
- `MULTI_APPROVER` is a quorum requirement, not a role. It is deliberately not accepted by `PipelineApprovalRole` and must never be mapped to a single founder/admin/security approval. A quorum implementation needs a separate append-only decision table, distinct approver identities, a configured threshold, and a transaction that changes the request to `APPROVED` only when the threshold is reached. Until that exists, multi-approver policy must remain blocked.
- `SECURITY` policy decisions now have an explicit verifier role type; this is contract-level support only. It does not mean a live security-role membership adapter exists.


## Review of bundled HAPPY source snapshot (2026-11-06 archive)

The repository also contains `HAPPY-AI-SOURCE-REVIEW.zip`. This archive is a separate source snapshot dated 2026-11-06; it is not the same tree as the small Next.js shell checked out at the repository root, and it must not be assumed to be the current deployed source without a fresh sync.

Static review of that archive found:

1. **Supabase Auth and decision API exist in the archive.** `src/core/auth/supabase-runtime-context.ts` uses Supabase `getClaims()` plus `getSession()`; `src/app/api/approvals/decision/route.ts` exposes GET/POST and uses the authenticated server client. The route does not use a service-role key.
2. **Approval durability exists, but as a runtime snapshot.** Approval state and its audit event are changed in `happy_runtime_snapshots.state`; `saveIfVersion` updates by both `scope_key` and expected `version`, providing optimistic concurrency control. There is no dedicated normalized approval/decision table in the bundled migrations.
3. **Authorization is founder-only.** The route resolves the authenticated user against server env `HAPPY_FOUNDER_USER_ID`. `ADMIN`, `SECURITY`, and `MULTI_APPROVER` levels are explicitly rejected with `503 APPROVER_REGISTRY_NOT_YET_CONNECTED`. This is fail-closed, not general role authorization.
4. **Expiry is not enforced in the archive.** `ApprovalRequest.expiresAt` is optional in the type, but there is no runtime expiry check in `applyApprovalDecision` or the decision route. The function checks only that the current status is pending. An expired pending approval can therefore still be decided.
5. **First-run tenant scope mismatch is present in the archive.** The decision route calls `createAuthenticatedWorkspaceState`, which uses the file-backed tenant registry. Its bootstrap fallback creates IDs with `org-${randomUUID()}` and `workspace-${randomUUID()}`; the Supabase runtime snapshot adapter requires UUID-formatted organization/workspace/user IDs before loading. The route does not call `resolveCanonicalSupabaseTenant`. A newly bootstrapped file-backed tenant can therefore fail before approval state is loaded with `INVALID_SUPABASE_SCOPE`, unless the registry already contains canonical UUIDs.
6. **Membership schema exists but is not the approval authorizer.** The migrations define organization/workspace membership with `owner/admin/member` roles and RLS helper functions. The decision route does not consult those membership roles; it uses the single configured founder identity.

### Required fixes before claiming production-complete approvals

- Add expiry validation to the decision mutation itself (not only UI): reject malformed/expired `expiresAt` before mutating state, and persist an explicit `EXPIRED` state/audit result through a safe state transition.
- Resolve canonical Supabase tenant IDs from the authenticated access token in the approval route, with provisioning disabled for read/decision paths unless a separate approved provisioning flow is invoked. Do not pass file-generated prefixed IDs to the UUID-only snapshot adapter.
- Keep the current founder-only gate until a trusted membership/role mapping is implemented. Do not silently allow ADMIN or SECURITY based on client fields.
- Implement multi-approver as a true quorum with distinct approvers and transactional threshold enforcement; never treat it as one role.
- Refresh the bundled source from the current canonical working tree before applying these changes. The 2026-11-06 archive is a review artifact, not proof of current deployment state.
