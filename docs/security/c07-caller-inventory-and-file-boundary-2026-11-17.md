# C-07 caller inventory and execution-boundary follow-up

Date: 2026-11-17
Repository: `razanaushad974-coder/HAPPY-BASE`
Reviewed ref: `main`
Reviewed tree SHA: `5ac91e870f2fc4a79d57a75d55eab5bcb099a1d1`
Tree response: 179 tracked blobs; recursive tree was not truncated.

## Repository surface relevant to caller reachability

The current `main` tree contains only these App Router files:
- `src/app/page.tsx`
- `src/app/layout.tsx`
- `src/app/globals.css`
- `src/app/favicon.ico`

There is no `src/app/api/**/route.ts`, no server-action file, and no HTTP API route in the reviewed tree. `src/app/page.tsx` is the unmodified Next.js starter page and does not import or invoke HAPPY orchestration. Therefore this review has not identified an HTTP entrypoint that exposes `HappyOrchestrationEngine.run()` to an external caller. This is a repository-tree observation, not proof about deployments, other branches, external services, or untracked code.

## Direct orchestration construction and call sites confirmed

| File | Role | Finding |
|---|---|---|
| `src/core/orchestration/engine.ts` | Defines `HappyOrchestrationEngine`; constructs registry, real adapters and `ExecutionEngine`; exposes `run(request)` | Core trust boundary. Caller-supplied `request.approved` is used to mark approval and populate execution request. |
| `src/core/orchestration/orchestrator.ts` | Defines `HappyOrchestrator`; constructor creates `new HappyOrchestrationEngine(persistenceFile)`; `run(request)` forwards the request | Only non-test source-level constructor of the orchestration engine found in direct source inspection. No auth/approval service is injected. |
| `src/tests/core/orchestration/orchestration.test.ts` | Instantiates `HappyOrchestrator` and calls `run()` three times | Test explicitly sends `approved:false` for normal and pending cases, and `approved:true` for the approved execution case. This codifies the unsafe public boolean contract. |
| `src/core/execution/engine.ts` | Generic execution boundary | Checks only `requiresApproval && !approved`; if caller sets `requiresApproval:false`, no approval proof is required. |
| `src/core/execution/orchestrator.ts` | Thin wrapper around injected `ExecutionEngine` | `runTask(request)` forwards a caller-constructed `ExecutionRequest`; no independent approval lookup. |
| `src/core/execution/default-registry.ts` | Creates a registry with ten disconnected contract adapters | This factory alone is not the registry used by `HappyOrchestrationEngine`; that engine builds its own registry and registers live FILE/API/BROWSER/DATABASE adapters. |

Direct source review of the founder OS, founder command, workspace, API, build, billing, mission, and execution/orchestration wrapper files inspected in this pass did not reveal another `HappyOrchestrationEngine` constructor or a call to its `run()`. GitHub's code-search connector returned zero indexed matches for the relevant symbols, so absence claims are limited to the inspected tree and files, not a reliable global code-search result.

## Additional execution-boundary finding — FILE adapter

The current orchestration constructor registers `new FileExecutionAdapter()`; the adapter reports `AVAILABLE`. In `FileExecutionAdapter.execute()`, the approval guard is conditional:

```ts
if (request.requiresApproval && !request.approved) {
  return WAITING_APPROVAL;
}
```

Therefore a direct adapter caller can set `requiresApproval:false` and execute CREATE/MODIFY/COPY/MOVE/RENAME/DELETE without a verified approval. The existing `src/tests/core/execution/file-execution-adapter.test.ts` positively exercises CREATE with `requiresApproval:false, approved:true`; it does not test false/false or forged true. This is a confirmed missing enforcement at the adapter boundary, not merely a theoretical orchestration issue.

The generic `ExecutionEngine` has the same conditional boolean gate. `ExecutionOrchestrator.runTask()` forwards its request to that engine without approval lookup.

The DATABASE adapter is more restrictive: for DB_INSERT/UPDATE/DELETE/TRANSACTION it returns WAITING_APPROVAL if either `requiresApproval` or `approved` is false. However, the two booleans remain caller-controlled and are not a persisted server-verified decision. API adapter mutating HTTP methods also use the same boolean pair. The browser adapter supports CLICK/FILL actions; this pass has not completed a full side-effect classification of browser operations.

## Severity and exploitability statement

- Confirmed: caller-controlled approval booleans can mark a pipeline approval record APPROVED; generic execution and FILE adapter do not validate an authoritative decision.
- Confirmed: FILE mutations can execute through a direct adapter invocation with `requiresApproval:false`; no trusted approval lookup occurs.
- Not demonstrated: an unauthenticated remote exploit against the deployed application. No relevant HTTP route exists in the reviewed `main` tree, and deployed code/other branches were not tested.
- Operational risk: any internal caller, future route, plugin, job, or automation that can instantiate or receive these objects could reach the weak boundary unless guarded elsewhere.

## Required containment before source integration

1. Do not expose `HappyOrchestrator.run()`, `HappyOrchestrationEngine.run()`, `ExecutionEngine.execute()`, or adapters to untrusted request objects.
2. Treat FILE mutations as blocked unless a server-side approval authorizer validates an approval bound to tenant, actor, request, action, path/target and input digest. Do not accept `requiresApproval:false` as a caller override for mutations.
3. Change execution APIs so policy/risk classification is computed server-side and cannot be downgraded by request payload.
4. Ensure direct adapter calls cannot bypass the authorizer; add tests for false/false, true/true forged, direct invocation, replay, expiry, tenant mismatch, changed target/input, and concurrent consumption.
5. Preserve read-only FILE READ separately from mutation actions; explicitly classify API methods and browser actions.
6. Add authenticated route tests once a real route is introduced. Do not invent an API route merely to make this review appear complete.

## Tests requiring correction

- `src/tests/core/orchestration/orchestration.test.ts`: replace the `approved:true` test fixture with a persisted approval-service decision flow; add forged boolean and approval replay tests.
- `src/tests/core/execution/file-execution-adapter.test.ts`: add direct mutation requests with `requiresApproval:false, approved:false` and `requiresApproval:false, approved:true`; both must be blocked without a verified grant.
- `src/tests/core/execution/execution-adapter.test.ts`: add generic engine bypass attempts with caller-controlled `requiresApproval:false`.
- `src/tests/core/execution/database-execution-adapter.test.ts`: add forged true/true and tenant/target mismatch tests; keep fail-closed behavior.
- Add authorizer contract tests for actor, tenant, resource, action, input digest, expiry, replay and concurrency.

## Scope limitations and safety

This is static source inspection on `main` at the tree SHA above. It is not a complete semantic audit of every capability or an end-to-end deployment test. No source code, tests, database, migrations, merge state, or production deployment were changed. No exploit was executed. The document is a review artifact only.
