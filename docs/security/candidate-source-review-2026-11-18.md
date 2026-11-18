# Candidate source review — 2026-11-18

## Reviewed artifact and limits

- Uploaded archive: `HAPPY-AI-WORKING-UPDATED-security-reviewed-candidate.zip`
- SHA-256: `ab39f72492295b34a6ab663d540d9d48ae9233269000bdac2a96fc45618ef00d`
- Archive entries: 362; ZIP integrity check: PASS.
- GitHub `main` tree inspected at `5ac91e870f2fc4a79d57a75d55eab5bcb099a1d1` (236 tree entries; not truncated).
- Candidate is not a drop-in replacement for `main`. This pass hash-compared 17 selected overlapping files: 12 differ and 5 match. The complete 362-path matrix remains outstanding.
- TypeScript syntax transpilation: 329 TS/TSX files, zero syntax diagnostics (TypeScript 5.8.3 transpile-only). This is not a semantic typecheck.
- Full dependency installation, typecheck, lint, Vitest, npm audit, and production build were not completed in this pass. Candidate has no `node_modules`; its own release note records the previous `npm ci` attempt timed out.

## Confirmed source alignment

Selected candidate-vs-`main` content-hash results:

| Path | Result |
|---|---|
| `.gitignore` | DIFF |
| `AGENTS.md` | MATCH |
| `CLAUDE.md` | MATCH |
| `next.config.ts` | MATCH |
| `package-lock.json` | DIFF |
| `package.json` | DIFF |
| `postcss.config.mjs` | MATCH |
| `src/app/page.tsx` | MATCH |
| `src/config/happy.ts` | DIFF |
| `src/core/orchestration/engine.ts` | DIFF |
| `src/core/orchestration/orchestrator.ts` | DIFF |
| `src/core/orchestration/types.ts` | DIFF |
| `src/core/execution/file-execution-adapter.ts` | DIFF |
| `src/core/execution/database-execution-adapter.ts` | DIFF |
| `src/core/execution/workspace-code-executor.ts` | DIFF |
| `eslint.config.mjs` | DIFF |
| `tsconfig.json` | DIFF |

Do not overwrite `main` or import the archive wholesale. The changed files require per-file semantic review and a dependency/lockfile reconciliation.

## Release blocker — vulnerable framework baseline

The candidate manifest and lockfile both resolve `next` and `eslint-config-next` to `16.3.5`. The November 3, 2026 Next.js security release patched the 16.x line in `16.4.5`; later `16.4.6` is available. Upgrade both packages together, regenerate the lockfile from the candidate manifest, and validate the exact resulting tree before release.

References:
- https://www.netlify.com/changelog/2026-11-03-nextjs-security-vulnerabilities/
- https://nextjs.org/blog (security release notes)

## HIGH — file-backed tenant IDs do not reliably match canonical Supabase tenant IDs

Evidence:
- `src/core/workspace/file-backed-state.ts` bootstraps tenants with `org-${randomUUID()}` and `workspace-${randomUUID()}` (around line 613).
- `src/app/api/execute/route.ts` and `src/app/api/founder/execute/route.ts` call `createAuthenticatedWorkspaceState()` (around lines 173 and 119).
- `persistAuthenticatedRuntimeSnapshot()` refuses non-UUID organization/workspace/user scopes and returns `NOT_YET_CONNECTED` instead of saving (around line 65).
- `src/app/api/approvals/decision/route.ts` independently resolves the existing canonical Supabase tenant with `allowProvisioning: false` (around line 94), then loads the remote snapshot for that UUID scope.

Impact:
For a newly bootstrapped file-backed tenant, the execution route can write to the local `.happy-state` store while remote snapshot persistence is skipped; the approval route then looks for a different canonical UUID scope and can find no snapshot. This is conditional on the registry not already containing matching UUID tenant IDs, but it is a real integration blocker for the bootstrap path.

Required remediation:
Use one authenticated, server-resolved canonical tenant scope in every execution and approval route. Do not let a local registry mint a second tenant identity for a Supabase-authenticated user. Add route integration tests for first-run bootstrap, existing tenant, ambiguous tenant, and mismatch rejection.

## HIGH — remote snapshot version is reset by normal execution writes

Evidence:
- `persistAuthenticatedRuntimeSnapshot()` calls `SupabaseRuntimeSnapshotStore.save()` (not `saveIfVersion()`).
- The caller defaults/passes version `1`; the store's `save()` upserts the row with that version.
- `/api/execute` and `/api/founder/execute` call this helper with version `1`.
- Approval decisions separately use `saveIfVersion(scope, state, context.snapshot.version)`.

Impact:
Repeated normal executions can overwrite the remote snapshot with version 1 rather than advancing a monotonic version. That undermines the CAS/version contract used by approval decisions and can allow stale state to replace newer state.

Required remediation:
Make all remote writes version-aware and atomic. Define a single create-if-absent / compare-and-swap persistence contract; never use unconditional upsert for runtime state transitions. Add concurrent writer, stale version, and first-write tests.

## HIGH — approval decision is saved remotely before resume, but resumed state is not saved remotely

Evidence:
- Approval POST persists the approved state with `saveIfVersion()` (around line 533).
- It then hydrates `createWorkspacePersistence()` from that state and calls `HappyOrchestrationEngine.resumeAfterApproval()` (around lines 577–635).
- `createWorkspacePersistence()` is backed by `JsonFileStateAdapter` at `.happy-state/orchestration-state.json`.
- The route does not persist the post-resume state back to the Supabase snapshot after `resumeAfterApproval()` returns.

Impact:
The remote snapshot can remain at the just-approved / pre-resume state while task, execution, verification, and evidence updates are written to the file-backed persistence layer. A successful resume response therefore does not establish that the resulting runtime state is durably synchronized remotely.

Required remediation:
Run continuation against a persistence service that writes to the authoritative remote store, or perform a safe CAS save of the post-resume state before returning success. On failure, return an explicit recovery-required status and preserve enough durable evidence to reconcile. Add a test that reloads Supabase after resume and asserts the resumed mission/task/execution state is present.

## HIGH — generic approval booleans and direct adapter bypass remain in candidate

Evidence:
- `HappyPipelineRequest` still exposes `approved?: boolean` (`src/core/orchestration/types.ts`, around line 70).
- The orchestration engine maps `request.approved === true` into execution requests.
- `FileExecutionAdapter` still gates mutation only with `request.requiresApproval && !request.approved` (around line 168); a direct caller can set `requiresApproval: false`.
- `DatabaseExecutionAdapter` applies the same conditional gate to DB writes (around line 209), so a direct caller-controlled `requiresApproval: false` bypasses it.
- API and browser adapters also use the same boolean pair for side-effecting operations.

Qualification:
The candidate's `/api/execute` route currently constructs `approved: false`; this review did not demonstrate an unauthenticated HTTP exploit through that route. The finding is a core/adapter trust-boundary weakness and must not be described as a proven remote exploit.

Required remediation:
Derive approval policy server-side. Remove caller-supplied approval as authorization evidence. Require an injected server-owned authorizer that validates a persisted grant bound to actor, tenant, request, action, target, and exact input; consume it atomically once. Block direct FILE/DB/API/browser side effects when no authorizer is present. The PR #7 FILE default-deny patch is not present in this archive's `file-execution-adapter.ts`; PR #7 is a separate branch and remains unmerged.

## MEDIUM — runtime snapshot tenant integrity

The candidate migration `20260919000100_happy_runtime_snapshots.sql` stores organization/workspace IDs as text without foreign keys to canonical tenant tables. Its four RLS policies check only `user_id = auth.uid()`; they do not independently verify workspace membership. This does not demonstrate cross-user disclosure, because the user predicate remains in place, but it permits a user to create their own snapshot rows under arbitrary organization/workspace identifiers.

Required remediation:
Design a forward-only migration after validating existing data: UUID tenant columns, composite workspace/organization foreign key, and membership-based RLS consistent with `happy_module_records`. Add direct-client cross-workspace and cross-organization RLS tests. Do not apply the migration as part of this source-review change.

## Other review notes

- Approval expiry is implemented in the mutation layer with a 24-hour default, bounded configured TTL, legacy `createdAt` fallback, explicit EXPIRED transition, audit event, and CAS persistence in the approval route. The supplied tests cover these cases, but full project tests were not run in this pass.
- Canonical tenant resolution authenticates the supplied access token and resolves owner-scoped organization/workspace records without provisioning in the approval route. This is a positive control, but it does not repair the separate file-backed tenant usage in execution routes.
- `FileExecutionAdapter` hardening in PR #7 is not integrated into the archive; the archive must not be treated as if that protection is present.
- No database writes/migrations, source import to `main`, PR merge, or production deployment were performed.

## Recommended integration order

1. Reconcile the full candidate/main path matrix and select only intentional changes.
2. Resolve canonical tenant identity across execution, approval, and runtime persistence.
3. Fix remote snapshot CAS/version handling and persist post-resume state remotely.
4. Replace boolean approval trust with server-owned, one-time authorizers across all side-effecting adapters.
5. Apply the snapshot tenant/FK/RLS hardening through a separately reviewed forward migration.
6. Upgrade Next.js and regenerate the lockfile.
7. Run full install, audit, typecheck, lint, focused tests, full tests, and production build on the exact integrated tree.
8. Only then request review; keep PRs draft/unmerged and production untouched until explicit approval.
