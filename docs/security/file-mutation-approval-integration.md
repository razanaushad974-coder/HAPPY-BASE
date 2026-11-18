# File mutation approval boundary

`FileExecutionAdapter` now treats every non-`READ` operation as approval-required independently of the caller-controlled `requiresApproval` flag.

## Default behavior

- `CREATE`, `MODIFY`, `COPY`, `MOVE`, `RENAME`, and `DELETE` return `WAITING_APPROVAL` unless a server-owned `FileMutationAuthorizer` is injected.
- `approved: true` and `requiresApproval: false` are not authorization evidence.
- Authorizer exceptions fail closed.
- `READ` remains available without a mutation grant.

## Integration assessment

The current `happy/server-verified-pipeline-approval` base branch does not contain the server runtime needed to wire a production authorizer:

- Its recursive Git tree contains 241 entries and no `src/app/api/**/route.ts` server routes.
- It contains no Supabase tenant resolver, authenticated Supabase runtime context, or durable Supabase approval-store implementation.
- `PersistedPipelineApprovalVerifier` is an injectable contract. Its approval record binds request, plan, organization, workspace, requester, approver, status, expiry, and role, but it does not bind a decision to a specific file operation, source/destination path, or content digest, and it does not atomically consume a file-mutation grant.
- `HappyOrchestrationEngine` currently constructs `new FileExecutionAdapter()` without an authorizer. The safe default therefore blocks mutations.

Reusing the existing pipeline verifier alone would be unsafe: an approved pipeline request is not proof that an exact file mutation (including its target and content) was approved, and the verifier has no one-time file-grant consumption contract.

## Required production integration

Before enabling file mutations, add the integration in the actual authenticated server composition root. It must provide:

1. A session provider that derives the actor and organization/workspace membership from the validated server session, never request JSON.
2. A durable tenant-scoped approval store.
3. An approval grant bound to request ID, plan ID, requester, approver, tenant, exact operation, normalized source and destination paths, target reference, and a cryptographic digest of the complete mutation input.
4. Atomic one-time consumption that rejects pending, expired, revoked, already-consumed, mismatched, or replayed grants.
5. Dependency injection of that authorizer into the server-owned `FileExecutionAdapter`; never accept a client-supplied authorizer or authorization context.

Do not implement the authorizer by checking `ExecutionRequest.approved` or by accepting actor, role, tenant, or approval claims from request input. Until the server runtime and durable store exist on the target branch, mutations intentionally remain blocked. The injected test authorizer is only a contract test double, not a production implementation.

This change is defense-in-depth for the direct-adapter bypass. It does not claim that all other execution adapters or every possible direct use of the low-level workspace executor are secured.
