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


## Additional boundary finding: FILE READ authorization

The current adapter deliberately bypasses the mutation-grant authorizer for `READ`. Source inspection confirms:

- `FileExecutionAdapter.canExecute()` accepts a FILE target and the `READ` action without an authenticated session or tenant-scope check.
- `FileExecutionAdapter.execute()` calls `WorkspaceCodeExecutor.executeOperation()` for READ without consulting the mutation authorizer.
- `ExecutionEngine.execute()` performs capability/adapter checks and the legacy caller-controlled approval gate, but does not authenticate the actor or resolve organization/workspace membership.
- The low-level executor resolves paths relative to its configured workspace root; it does not itself bind a read to a user, organization, or workspace membership record.

This inspection does **not** establish an unauthenticated remote exploit: the current target branch has no production server composition/API route wiring that exposes this engine. It does establish that the adapter/engine are not independently safe as an untrusted request boundary. Treat FILE READ as trusted-local-only until a server-owned read authorization boundary is added.

Before exposing FILE READ through any API, agent tool, browser session, or multi-tenant workspace, require a validated server session, canonical tenant/workspace membership, and a server-resolved workspace root/path scope for every read. Do not rely on `targetReference.entityType === FILE` as authorization. Add regression tests for cross-user, cross-workspace, traversal, and unauthorized READ attempts. This is separate from the one-time mutation grant: READ may use a scoped read policy rather than a mutation grant, but it must not be unauthenticated.
