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
