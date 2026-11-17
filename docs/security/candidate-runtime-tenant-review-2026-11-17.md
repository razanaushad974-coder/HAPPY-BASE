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
