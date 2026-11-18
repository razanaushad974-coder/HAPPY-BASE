# C-07 remediation contract — server-verified approval grants

Date: 2026-11-17
Repository: `razanaushad974-coder/HAPPY-BASE`
Target: application source remediation proposal; this document itself is documentation-only.

## Confirmed vulnerable contract

The current `HappyPipelineRequest` exposes caller-controlled `approved?: boolean`. `HappyOrchestrationEngine.run()` treats `true` as sufficient to leave the approval wait branch, writes an APPROVED-shaped record, and copies the boolean into `ExecutionRequest`. `ExecutionEngine.execute()` and the FILE adapter trust that boolean. The DATABASE adapter also gates writes using `requiresApproval && approved`, so changing only the orchestration branch would leave the generic execution trust contract unsafe.

The current `ExecutionRequest` also exposes `approved: boolean` and `requiresApproval: boolean`; these are policy hints, not proof of authorization. They must not remain the security authority.

## Required target contract

### 1. Separate request intent from approval authority

- Remove `approved?: boolean` from `HappyPipelineRequest`.
- Remove `approved: boolean` as an authorization credential from `ExecutionRequest`.
- Keep a derived `requiresApproval` / risk classification only as non-authoritative metadata if useful for UX and audit.
- An untrusted API, UI, automation, voice, or plugin payload must never be able to manufacture an approval grant by setting a boolean, status string, timestamp, actor id, or approval record-shaped object.

### 2. Create a server-owned approval grant

Approval decisions must be created only by the authenticated approval-decision service after it has:
- authenticated the current actor from a verified session/token;
- resolved canonical organization, workspace, and user scope without silently provisioning a new tenant;
- loaded the exact pending approval from authoritative persistence;
- checked actor authorization against the approval policy (including founder-only restrictions where applicable);
- bound the decision to the exact request, plan, mission/task, capability, action, target/resource, tenant scope, and material input digest;
- checked expiration and pending state;
- atomically consumed the pending approval exactly once, with replay/conflict rejected.

The service should return a narrow internal grant/reference (preferably opaque id + version or a branded in-process type), not a client-serializable `approved: true`. The grant is not accepted merely because its shape is valid: the execution boundary must resolve and validate it against authoritative approval persistence.

### 3. Enforce at the final mutation boundary

- Inject an `ApprovalAuthorizer` / approval-grant verifier into `ExecutionEngine` and mutation-capable adapters.
- Before invoking any mutating adapter, require a successful authoritative validation for the exact execution tuple.
- Fail closed if the authorizer is absent, persistence is unavailable, scope is incomplete, the approval is expired, already consumed, mismatched, revoked, or cannot be loaded.
- Apply the same enforcement to FILE, DATABASE, SHELL, CODE, API, BROWSER, DEPLOYMENT, PUBLISH, and AUTOMATION wherever actions can mutate state or create external side effects. Classify read-only operations explicitly; do not infer read-only from an untrusted label.
- Adapters must not independently trust a boolean supplied in `ExecutionRequest`. Prefer passing a verified, immutable authorization context from the engine, while still requiring adapters to reject calls that bypass the engine if they are directly callable.
- Preserve tenant isolation, RLS, founder-only authorization, approval audit events, and existing approval-resume/recovery semantics.

### 4. Avoid approval time-of-check/time-of-use gaps

The approval must be consumed atomically with a state transition (for example PENDING -> CONSUMED) before side effects begin. Persist an execution/idempotency key and bind it to the approved input digest. On retry or crash recovery, resume only the same authorized execution; never mint a fresh approval from a prior `approved` boolean or replay a consumed grant. If execution fails after consumption, recovery must use a durable execution state machine and explicit policy for retry/compensation, not reopen approval implicitly.

## Mandatory negative and positive test matrix

| Area | Test | Expected |
|---|---|---|
| Public contract | Submit `approved: true` to pipeline/API payload | Ignored/rejected; no approval bypass |
| Orchestration | Plan requires approval; no persisted decision | WAITING_APPROVAL; zero adapter calls |
| Forgery | Supply fabricated grant id/object/status | BLOCKED; zero side effects |
| Actor | Approval belongs to another user | BLOCKED |
| Tenant | Approval belongs to another organization/workspace | BLOCKED |
| Binding | Same approval, altered plan/request/task/action/target/resource | BLOCKED |
| Input integrity | Same approval, changed material input digest | BLOCKED |
| Expiry | Approval expired immediately before execution | BLOCKED |
| Replay | Reuse a consumed approval/grant | CONFLICT/BLOCKED; no second side effect |
| Race | Two concurrent consumers race for one approval | Exactly one succeeds |
| Persistence | Approval store unavailable or malformed | Fail closed |
| Bypass | Call FILE/DATABASE adapter directly without verified context | BLOCKED |
| Database | DB_INSERT/UPDATE/DELETE/TRANSACTION with only boolean true | BLOCKED |
| File | CREATE/MODIFY/COPY/MOVE/RENAME/DELETE with only boolean true | BLOCKED |
| Read-only | Authorized read-only operation without mutation approval | Allowed only under explicit read policy |
| Resume | Crash after consume and before/after side effect | Same execution idempotently reconciled; no reapproval forgery |
| Audit | Decision, consume, execution, failure/recovery | Actor, tenant, approval id, execution id and timestamps recorded |

## Safe implementation sequence

1. Inventory every constructor and call-site of `HappyOrchestrationEngine`, `ExecutionEngine`, and every adapter; identify HTTP, job, automation, plugin, and test entry points.
2. Introduce the approval-authorizer interface and persistence-backed implementation with unit tests before changing callers.
3. Change the pipeline/API contract to remove caller-supplied approval booleans; route all decisions through the authenticated approval service.
4. Enforce verified grants at engine and adapter boundaries; explicitly classify read-only operations.
5. Add the negative tests above, including concurrency, tenant mismatch, replay, and direct-adapter invocation.
6. Run focused tests, full typecheck, lint, full test suite, audit, and production build; report exact commands/results.
7. Review migration/backward compatibility and crash-recovery behavior before any deployment.

## Release gate

Do not merge or deploy a source fix until caller inventory is complete, all mutation paths are covered, direct-adapter bypass tests pass, and CI is green. Until then, keep mutation-capable routes/adapters disabled or otherwise server-side blocked where trusted authorization cannot be proven.

## Scope and evidence limitations

This is a remediation contract based on static review of the current `main` versions of:
- `src/core/orchestration/types.ts`
- `src/core/orchestration/engine.ts`
- `src/core/execution/types.ts`
- `src/core/execution/engine.ts`
- `src/core/execution/registry.ts`
- `src/core/execution/file-execution-adapter.ts`
- `src/core/execution/database-execution-adapter.ts`

The full repository caller inventory is still incomplete. No exploit was executed. No application source code, tests, database, migrations, production deployment, or `main` branch were changed as part of this documentation update.
