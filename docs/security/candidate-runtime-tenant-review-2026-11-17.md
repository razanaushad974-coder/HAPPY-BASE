# HAPPY candidate runtime and tenant security review — 2026-11-17

## Scope and safety
- Reviewed the isolated extracted candidate at `/mnt/data/happy-candidate-work`.
- This is a static source review only. No Supabase connection, live database query, migration execution, application source edit, deployment, or merge was performed.
- Findings below are source-level observations and must be verified with tests and a controlled database migration plan before release.

## Candidate integration posture
- Candidate contains 362 files; current GitHub `main` tree contains 179 tracked blobs.
- Confirmed `main` paths missing from candidate: `README.md`, `HAPPY-AI-SOURCE-REVIEW.zip`.
- Confirmed content-hash conflicts from the exact comparisons completed so far:
  - `package.json`
  - `package-lock.json`
  - `eslint.config.mjs`
  - `tsconfig.json`
  - `src/config/happy.ts`
  - `src/core/orchestration/engine.ts`
  - `src/core/execution/file-execution-adapter.ts`
  - `src/core/execution/database-execution-adapter.ts`
  - `src/core/execution/workspace-code-executor.ts`
- Other overlapping paths still require content-hash comparison; their presence in both trees is not being labeled a conflict until hashes are checked.
- A complete generated 362-path matrix remains pending.
- Candidate-only paths include Supabase runtime snapshot persistence, canonical tenant resolution, authenticated runtime context, approval decision API and mutation, module runtime, several workspace/API routes, new migrations, and additional recovery/concurrency tests. These must be reviewed as a dependency-connected feature set, not copied file-by-file without import analysis.

## Static tenant / RLS review

### Finding T-01 — runtime snapshot tenant columns are not relationally constrained
Severity: MEDIUM (integrity / tenant-scope hardening; no cross-user read exploit demonstrated).

Evidence:
- `20260919000100_happy_runtime_snapshots.sql` defines `organization_id` and `workspace_id` as `text not null`, with no foreign key to `organizations` / `workspaces`.
- Its four RLS policies constrain `user_id = auth.uid()`; they do not independently validate that the organization/workspace pair belongs to the authenticated user's membership.
- `SupabaseRuntimeSnapshotStore` requires UUID-formatted organization, workspace, and user IDs, and addresses records through a composite textual `scope_key`.
- By contrast, `happy_module_records` uses UUID tenant columns, a composite foreign key to `workspaces(organization_id,id)`, and `private.is_workspace_member(workspace_id)` RLS checks.

Impact:
- An authenticated user can potentially create or mutate their own snapshot row with arbitrary organization/workspace identifiers through a direct client call, subject to the own-user policy. This does not by itself grant access to another user's snapshot because `user_id = auth.uid()` remains enforced, and the approval route resolves the authenticated user's canonical tenant before loading the snapshot.
- The schema therefore has weaker tenant-integrity guarantees than the module-records table and relies more heavily on application-level canonical-scope resolution.

Recommended remediation before production:
1. Design a forward-only migration that changes the snapshot tenant columns to UUID (if confirmed compatible with existing data) and adds a composite FK to `workspaces(organization_id,id)`.
2. Add an RLS membership predicate consistent with the canonical tenant model, while retaining `user_id = auth.uid()` for per-user isolation.
3. Inventory and validate existing rows before adding constraints; do not silently drop or rewrite records.
4. Add direct authenticated-client tests for cross-tenant insert/update rejection and canonical-scope route tests.
5. Obtain explicit approval before applying any migration to a connected database.

### Finding T-02 — canonical tenant resolver is fail-closed on missing or ambiguous ownership
Status: positive control observed.
- Approval route calls `resolveCanonicalSupabaseTenant(accessToken, { allowProvisioning: false })`.
- Resolver authenticates the token via `auth.getUser(accessToken)`, filters organizations by `owner_user_id`, and workspaces by both organization and owner.
- It rejects multiple owned organizations/workspaces and does not create tenant rows when provisioning is disabled.
- Resolver's provisioning path creates owner membership rows, but the approval decision route does not invoke that path.

Residual consideration:
- This resolver only chooses owner-owned organization/workspace rows. If future collaboration flows permit non-owner workspace approvers, they need an explicit membership-based tenant selection and authorization contract rather than weakening the current owner-only lookup implicitly.

### Finding T-03 — authenticated runtime context uses claims plus session token
Status: positive control observed with limitation.
- Runtime context reads Supabase claims and then requires a session access token before returning an authenticated user context.
- Local development fallback is gated by `HAPPY_LOCAL_DEV_MODE === "true"` and the `happy_local_dev_session=1` cookie.
- Production configuration must ensure local-dev mode is never enabled and that all sensitive routes reject the fallback identity. Verify this across every route before release.

## Dependency and validation blockers
- Candidate `package.json` and lockfile resolve `next` and `eslint-config-next` to 16.3.5.
- Attempt to resolve 16.4.6 failed because the environment could not resolve `registry.npmjs.org` (`EAI_AGAIN`). No manual lockfile edit was made.
- Full dependency install, typecheck, lint, Vitest suite, npm audit, and production build remain unverified.
- Prior isolated validation remains limited to 329 TS/TSX syntax transpilation files (zero syntax diagnostics) and 8 focused approval assertions.

## Required next gates
1. Generate a machine-produced path matrix for all candidate and main paths, including Git blob hashes and file sizes.
2. Review every same-path conflict as a semantic diff; preserve both sides' intent and all main-only assets.
3. Resolve T-01 schema design and add regression tests; do not execute the migration without explicit approval.
4. Restore package-registry access, update Next.js and matching eslint config with a regenerated candidate lockfile, then run full install/typecheck/lint/tests/audit/build.
5. Only after those gates, prepare a source integration PR. Do not merge or deploy this review branch as application source.


## Follow-up detail — snapshot scope key and membership model
Further source inspection confirms:
- `createRuntimeScopeKey` concatenates `organizationId|workspaceId|userId`; both `save` and `saveIfVersion` write those values, and `saveIfVersion` uses version-checked update / insert-on-version-zero.
- The core migration defines `workspace_members(workspace_id,user_id,role)` and `private.is_workspace_member(uuid)` as a `SECURITY DEFINER` helper with an empty pinned search path. Execute permission is explicitly granted to authenticated after revoking public/anon/authenticated defaults and re-granting authenticated.
- `happy_module_records` applies this membership helper in SELECT/INSERT/UPDATE/DELETE policies and has a composite FK to `workspaces(organization_id,id)`.
- `happy_runtime_snapshots` does not use that helper, does not have the composite FK, and only constrains `user_id` to `auth.users`.

This strengthens the finding that snapshot rows are owner-user isolated but their tenant labels are not independently bound to a real workspace membership at the database layer. The scope key's inclusion of user ID and the approval route's canonical tenant resolution reduce application-path exposure, but direct authenticated table access remains the relevant RLS test case.

### Proposed regression cases (not executed)
1. User A inserts a snapshot with their own `user_id` and a random/nonexistent organization/workspace pair — expect rejection after hardening.
2. User A inserts with a real workspace belonging to User B but their own `user_id` — expect rejection unless User A is an active workspace member.
3. User A attempts to read/update/delete User B's snapshot — expect zero rows / RLS rejection.
4. A workspace member saves a snapshot for a valid workspace with their own user scope — expected behavior must be explicitly decided (current approval resolver is owner-only, so do not silently broaden this).
5. Mismatched organization/workspace pair — expect FK rejection.
6. Existing snapshot rows are inventoried for UUID validity, workspace existence, organization/workspace pairing, and user ownership/membership before any constraint migration.

No SQL test was run and no migration was applied.

## Follow-up semantic diff — shared execution conflicts

Compared the candidate and GitHub `main` implementations directly (source-level inspection):

### C-01 — database write approval regression (HIGH, integration blocker)
- GitHub `main` blocks every database write when either `requiresApproval` is false OR `approved` is false: `WRITE_ACTIONS.has(action) && (!request.requiresApproval || !request.approved)`.
- Candidate blocks only when `requiresApproval` is true AND `approved` is false: `WRITE_ACTIONS.has(action) && request.requiresApproval && !request.approved`.
- Therefore, in the candidate, a DB write with `requiresApproval=false` can reach the provider without approval. This weakens the fail-closed invariant present in `main`.
- Required resolution: preserve the `main` fail-closed condition or replace it only with a centrally enforced, independently tested policy that cannot be bypassed by a caller-supplied false flag. Add tests for all four combinations of `requiresApproval` / `approved` across each write action and transaction.
- Do not integrate the candidate database adapter until this is fixed and verified.

### C-02 — file path hardening and residual race
- Candidate `WorkspaceCodeExecutor` adds lexical traversal checks, realpath checks for existing ancestors, symlink/junction escape rejection, and hard-link rejection. These are meaningful improvements over `main`'s lexical-prefix-only check.
- The validation and subsequent filesystem operation are separate synchronous calls. A hostile local process able to replace a checked directory entry between validation and use may still create a TOCTOU race. Retain as a residual hardening item; do not describe the implementation as race-proof.

### C-03 — default execution registry behavior changes
- Candidate `createDefaultExecutionRegistry` registers a live `SupabaseDatabaseProvider` and `SafeShellExecutionAdapter`, plus automation as disconnected unless a pipeline is injected.
- `main` registers contract adapters for a fixed capability list and separate AI/code/file/API/browser/database adapters; its database adapter is constructed without a provider in the orchestration engine.
- This is a runtime capability change, not a mechanical refactor. Before integration, verify provider auth/session binding, tenant scope enforcement, RLS behavior, query allowlisting, transaction validation, and shell command policy. Do not infer safety from the provider's name or status alone.

### C-04 — orchestration engine is a broad architectural conflict
- Candidate changes registry construction, injects a `PersistenceService`, adds workspace-aware runtime execution routing, and adds durable resume idempotency/recovery audit logic alongside approval expiry.
- These changes depend on candidate-only modules and contracts. They must be integrated as a dependency-closed feature set with crash/concurrency tests, not copied as a single file over `main`.

### Verification status
These are static semantic comparisons. No tests were executed for these new findings, no provider was connected, and no database write or migration was performed.


### C-05 — safe-shell approval is caller-controlled (HIGH, security blocker)
Static inspection of candidate `SafeShellExecutionAdapter` and `safe-shell-policy.ts` found:
- `parseInput` copies `input.approved` from the execution payload.
- `evaluateSafeShellRequest` treats that field as the approval decision for every non-read-only command.
- The adapter does not independently require `request.requiresApproval` AND `request.approved`, nor does it bind the input approval flag to a persisted approval decision.
- Therefore, a caller able to construct the execution input can set `approved: true` and pass the policy for an allowlisted executable with non-read-only arguments, provided `HAPPY_ENABLE_SAFE_SHELL=true`.

Required resolution: remove caller-supplied approval as an authority; derive approval only from the trusted orchestration/approval context, enforce it at the adapter boundary, and test forged `input.approved=true`, missing approval, stale approval, and approved/unapproved request combinations. Until then, do not enable or integrate safe-shell execution.

### C-06 — Supabase provider trusts RLS for organization/workspace isolation
Static inspection of candidate `SupabaseDatabaseProvider` shows it requires a bearer access token, calls `auth.getUser(accessToken)`, and rejects a supplied `scope.userId` that differs from the authenticated user. It does not independently resolve or verify `organizationId` / `workspaceId` membership, nor does it add those tenant ids as query predicates. The provider passes the user JWT to PostgREST and relies on table RLS for row-level isolation.
- This is not proof of a cross-tenant exploit; correctly configured RLS may enforce the boundary.
- However, the generic resource selector permits any syntactically valid table identifier, so every reachable table must have correct RLS. The current provider does not offer a tenant-membership check as a second control.
- Required tests: attempt reads/inserts/updates/deletes against a workspace owned by another user; verify missing-RLS tables cannot be reached or are explicitly denied; verify org/workspace mismatch; verify user JWT is always used and service/secret key never reaches this provider.
- Keep DB_QUERY and DB_TRANSACTION disabled as the current provider does. Add explicit safeguards against unintended unfiltered UPDATE/DELETE if bulk mutation is not a deliberate approved capability.

No provider was connected and no database request was executed. These are static findings requiring authenticated integration tests before enablement.


## Remediation patch prepared in the local candidate copy — 2026-11-17

The two caller-controlled approval findings have been patched in the extracted candidate working copy (not imported into GitHub `main`):

1. **Database writes:** the adapter now fails closed unless `request.requiresApproval === true` AND `request.approved === true`. This restores the same gate already present in GitHub `main`.
2. **Safe Shell:** the adapter no longer uses `input.approved` as authority. It supplies approval to the shell policy only from the trusted `ExecutionRequest` fields (`requiresApproval && approved`). Caller payload flags cannot grant approval.

Focused executable checks were run against the transpiled candidate modules using a fake database provider and injected shell runner:
- DB writes rejected for (requiresApproval=false, approved=false), (false,true), and (true,false).
- DB write accepted only for (true,true).
- Forged shell payload `approved=true` with trusted request approval absent was rejected.
- Trusted request with approval required but not granted was rejected.
- Read-only `node --version` remained executable without approval.
- Result: all focused checks PASS.

The candidate's existing standalone test files were also extended with these regression cases, but the full Vitest/TypeScript/lint/build suite was NOT run because dependencies are not installed and the earlier package-registry DNS failure remains. The patch is local candidate-only; no GitHub application source was changed, no PR merge, no database write, and no deployment occurred.


## Additional baseline review — orchestration approval authority (C-07)

Severity: HIGH pending call-site/authentication verification; do not treat this as a demonstrated remote exploit.

Static inspection of GitHub `main` at the current review point:
- `HappyPipelineRequest` exposes an optional caller-provided `approved?: boolean` field.
- `HappyOrchestrationEngine.run()` treats `request.approved === true` as sufficient to pass the plan-level approval gate.
- When that boolean is true, the engine itself writes an `APPROVED` approval record with `approvedAt`; the record is not loaded from or cross-checked against an independently persisted approval decision in this method.
- The resulting `ExecutionRequest.approved` is then populated from the same caller boolean. The generic `ExecutionEngine` and file adapter also trust this boolean when deciding whether to proceed.

Security interpretation:
- The orchestration class does not establish approval authority itself. Safety therefore depends on every caller being a trusted server-side boundary that authenticates the founder, loads a pending approval, validates its scope/expiry/status, and only then supplies `approved: true`.
- The expected `src/app/api/founder/execute/route.ts` and `src/app/api/approvals/decision/route.ts` paths were not present on GitHub `main` at the time of this fetch (404); candidate-only routes described elsewhere in this review are not evidence of protection in `main`.
- No call-site inventory or live request test has yet established whether an untrusted caller can reach this engine with a forged approval flag.

Required next steps before release:
1. Inventory every construction/call site of `HappyOrchestrationEngine.run()` and all external routes that can reach it.
2. Ensure approval is represented by a server-verified decision record or opaque trusted authorization context, not a public boolean supplied by the request body.
3. Enforce pending status, expiry, target request/plan, tenant/user scope, and one-time consumption at the mutation boundary.
4. Add negative tests proving a forged `approved: true` cannot create an APPROVED record or execute a FILE/DATABASE/SHELL mutation.

No source code was changed, no test was executed, and no database or deployment action was performed for this finding.


## Additional baseline review — workspace symlink escape (C-08)

Severity: HIGH if FILE execution is reachable against a workspace containing attacker-controlled symlinks; exposure depends on workspace write access and execution call-site controls.

Static evidence in GitHub `main` `src/core/execution/workspace-code-executor.ts`:
- `resolveSafePath()` resolves the requested relative path and checks only that the resulting lexical path begins with the configured workspace root prefix.
- It does not resolve the real path of existing ancestors or reject symlinks/junctions/hard links.
- CREATE/MODIFY/COPY/MOVE/RENAME/DELETE subsequently operate on the resolved path using ordinary filesystem calls.

A pre-existing symlink inside the workspace can therefore point outside the workspace while its lexical path still passes the prefix check. For example, a path like `linked-dir/target.txt` can resolve lexically below the root even when `linked-dir` is a symlink to an external directory. This is a static path-validation bypass scenario; no filesystem exploit was executed.

Required remediation:
1. Preserve the candidate's stronger realpath/ancestor/symlink checks, but close the remaining validation-to-use TOCTOU window with directory-handle-relative operations / no-follow semantics where supported, or isolate execution in a filesystem sandbox that prevents writes outside the workspace.
2. Validate both source and destination paths for COPY/MOVE/RENAME and revalidate after parent-directory creation.
3. Add platform-specific tests for POSIX symlinks, Windows junctions/reparse points, hard links, missing nested parents, and concurrent path replacement.
4. Keep FILE mutations disabled or approval-gated until the execution boundary and caller authorization are verified.

No source code was changed, no filesystem exploit or test was executed, and no deployment action was performed for this finding.


## C-07 follow-up — caller inventory status

A repository-scoped GitHub code search was attempted for `HappyOrchestrationEngine.run(`, `new HappyOrchestrationEngine`, and related approval call patterns. The search connector returned no indexed matches. This is an indexing/search limitation, not proof that there are no callers.

The direct source inspection confirms the trust-boundary defect inside the orchestration API: a boolean field on `HappyPipelineRequest` controls the approval gate and is copied into `ExecutionRequest.approved`. The current evidence is therefore sufficient to require remediation of the API contract, but insufficient to claim an unauthenticated remote exploit. A complete caller inventory must be obtained from a repository tree/clone and reviewed before any release sign-off.

Recommended safe API direction:
- Remove public `approved?: boolean` from the general pipeline request contract.
- Keep normal pipeline execution unable to mark an approval as approved.
- Introduce a server-only continuation entry point that accepts a validated approval decision identifier/context after checking authenticated actor, request/plan binding, organization/workspace/user scope, expiry, pending state, and one-time consumption.
- Do not mint an APPROVED record inside the orchestration engine merely because a boolean is true; persist the decision through the approval service and consume it atomically.
- Add tests at both the route boundary and execution adapter boundary for forged flags and replayed decisions.

Status: finding documented; no application patch or caller-level verification completed. No tests, database writes, migrations, merges, or deployments were performed.
