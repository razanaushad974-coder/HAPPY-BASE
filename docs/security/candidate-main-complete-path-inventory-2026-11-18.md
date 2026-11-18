# Candidate/Main complete path inventory — 2026-11-18

## Scope and method

Compared the exact 362-file uploaded ZIP inventory against the complete, non-truncated recursive Git tree of `main` at commit `5ac91e870f2fc4a79d57a75d55eab5bcb099a1d1`.

This is a complete **path-presence matrix**, not a complete content-diff audit. The path sets are exact:
- Candidate archive: 362 files
- GitHub main: 179 blobs
- Same path in both: 177
- Candidate-only paths: 185
- Main-only paths: 2

The 17-file content hash sample recorded in `candidate-source-review-2026-11-18.md` is separate: 12 changed, 5 matching. Content hashes have not yet been compared for all 177 shared paths. Do not interpret "same path" as "same source".

## Candidate-only paths (185)

### Root and documentation (12)
- `.env.example`
- `.happy-approval-route.vitest.config.mts`
- `SOURCE-SNAPSHOT-NOTES.md`
- `docs/security/approval-expiry-tenant-remediation.md`
- `docs/security/candidate-release-blockers-2026-11-17.md`
- `next-env.d.ts`
- `tsconfig.tsbuildinfo`
- `vitest.config.mts`
- `vitest.system-features.config.mts`
- `vitest.tenant-diagnostic-route.config.mts`
- `vitest.tenant-readonly.config.mts`
- `supabase/.gitignore`

### App routes and pages (25)
- `src/app/api/approvals/decision/route.ts`
- `src/app/api/auth/local-dev/route.ts`
- `src/app/api/auth/me/route.ts`
- `src/app/api/capabilities/route.ts`
- `src/app/api/execute/route.ts`
- `src/app/api/founder/execute/route.ts`
- `src/app/api/preview/route.ts`
- `src/app/api/runtime/snapshot/route.ts`
- `src/app/api/runtime/snapshot/smoke/route.ts`
- `src/app/api/system/canonical-tenant-diagnostic/route.ts`
- `src/app/api/system/features/route.ts`
- `src/app/api/system/modules/route.ts`
- `src/app/api/system/readiness/route.ts`
- `src/app/api/system/tenant-diagnostic/route.ts`
- `src/app/api/workspace/state/route.ts`
- `src/app/local-dev/page.tsx`
- `src/app/login/page.tsx`
- `src/app/preview/page.tsx`
- `src/app/workspace/approval-smoke/page.tsx`
- `src/app/workspace/approvals/page.tsx`
- `src/app/workspace/page.tsx`
- `src/app/workspace/supabase-smoke/page.tsx`
- `src/app/workspace/system/modules/ModuleRegistryClient.tsx`
- `src/app/workspace/system/modules/page.tsx`
- `src/app/workspace/system/page.tsx`

### Core runtime and integration (55)
- `src/core/agents/registry.ts`
- `src/core/approval/expiry-policy.ts`
- `src/core/approval/persist-decision.ts`
- `src/core/auth/supabase-runtime-context.ts`
- `src/core/authorization/happy-feature-access.ts`
- `src/core/automation/policy.ts`
- `src/core/automation/runtime.ts`
- `src/core/capabilities/index.ts`
- `src/core/capabilities/registry.ts`
- `src/core/capabilities/types.ts`
- `src/core/context/memory-context-engine.ts`
- `src/core/database/supabase-database-provider.ts`
- `src/core/database/supabase-server-config.ts`
- `src/core/execution/automation-execution-adapter.ts`
- `src/core/execution/control-gates.ts`
- `src/core/execution/happy-module-execution-adapter.ts`
- `src/core/execution/runtime-context.ts`
- `src/core/execution/runtime-policy.ts`
- `src/core/execution/safe-shell-adapter.ts`
- `src/core/execution/safe-shell-policy.ts`
- `src/core/founder/access-policy.ts`
- `src/core/founder/identity.ts`
- `src/core/founder/runtime-bridge.ts`
- `src/core/happy/index.ts`
- `src/core/happy/kernel/contracts/happy-identity.ts`
- `src/core/happy/kernel/contracts/happy-runtime.ts`
- `src/core/happy/kernel/feature-catalog.ts`
- `src/core/happy/kernel/feature-completion.ts`
- `src/core/happy/kernel/feature-registry.ts`
- `src/core/happy/kernel/registry/happy-domain-registry.ts`
- `src/core/happy/kernel/registry/happy-major-module-catalog.ts`
- `src/core/happy/kernel/registry/happy-module-bootstrap.ts`
- `src/core/happy/kernel/registry/happy-module-capability-binding.ts`
- `src/core/happy/kernel/registry/happy-module-runtime.ts`
- `src/core/happy/kernel/registry/happy-system-manifest.ts`
- `src/core/happy/kernel/runtime/happy-control-plane.ts`
- `src/core/happy/kernel/runtime/happy-execution-route.ts`
- `src/core/happy/kernel/runtime/happy-module-router.ts`
- `src/core/integration/happy-module-evidence.ts`
- `src/core/integration/happy-module-readiness.ts`
- `src/core/integration/runtime-persistence.ts`
- `src/core/integration/runtime-state-source.ts`
- `src/core/integration/system-readiness.ts`
- `src/core/modules/data/module-data-store.ts`
- `src/core/modules/data/module-persistence.ts`
- `src/core/modules/data/real-supabase-module-persistence.ts`
- `src/core/modules/runtime/happy-module-data-service.ts`
- `src/core/modules/runtime/happy-module-runtime-bridge.ts`
- `src/core/modules/runtime/module-runtime-registry.ts`
- `src/core/persistence/adapters/supabase-runtime-snapshot.ts`
- `src/core/workflow/engine.ts`
- `src/core/workspace/file-backed-state.ts`
- `src/core/workspace/live-dashboard.ts`
- `src/core/workspace/live-state-service.ts`
- `src/core/workspace/supabase-tenant-resolver.ts`

### Supabase and framework adapters (5)
- `src/lib/supabase/client.ts`
- `src/lib/supabase/server.ts`
- `src/proxy.ts`
- `src/server/supabase-auth.ts`
- `supabase/config.toml`

### New tests (84)
- `src/tests/core/agents/builder-agents-workflow.test.ts`
- `src/tests/core/approval/expiry-policy.test.ts`
- `src/tests/core/approval/persist-decision.test.ts`
- `src/tests/core/authorization/feature-access-gate-regression.test.ts`
- `src/tests/core/authorization/happy-feature-access.test.ts`
- `src/tests/core/capabilities/execution-registry.test.ts`
- `src/tests/core/capabilities/registry.test.ts`
- `src/tests/core/context/ai-request-context.test.ts`
- `src/tests/core/context/memory-context-engine.test.ts`
- `src/tests/core/control/control-gates.test.ts`
- `src/tests/core/database/supabase-provider.test.ts`
- `src/tests/core/execution/canonical-registry-safety-gate.test.ts`
- `src/tests/core/execution/runtime-context.test.ts`
- `src/tests/core/execution/runtime-policy.test.ts`
- `src/tests/core/execution/safe-shell-adapter.test.ts`
- `src/tests/core/execution/workspace-code-executor-symlink-boundary.test.ts`
- `src/tests/core/founder/access-policy.test.ts`
- `src/tests/core/happy/core-runtime-closure.test.ts`
- `src/tests/core/happy/execution-route.test.ts`
- `src/tests/core/happy/happy-module-data-service.test.ts`
- `src/tests/core/happy/happy-module-runtime-bridge.test.ts`
- `src/tests/core/happy/module-bootstrap.test.ts`
- `src/tests/core/happy/module-capability-binding.test.ts`
- `src/tests/core/happy/module-data-runtime.test.ts`
- `src/tests/core/happy/module-evidence.test.ts`
- `src/tests/core/happy/module-execution-contract.test.ts`
- `src/tests/core/happy/module-persistence.test.ts`
- `src/tests/core/happy/module-readiness.test.ts`
- `src/tests/core/happy/module-router-create-proof.ts`
- `src/tests/core/happy/module-router-direct-proof.ts`
- `src/tests/core/happy/module-router-native-proof.ts`
- `src/tests/core/happy/module-router.test.ts`
- `src/tests/core/happy/module-runtime-registry.test.ts`
- `src/tests/core/happy/real-supabase-module-persistence.test.ts`
- `src/tests/core/integration/approval-decision-api.test.ts`
- `src/tests/core/integration/approval-decision-route.runtime.test.ts`
- `src/tests/core/integration/approval-ui.test.ts`
- `src/tests/core/integration/founder-approval-authorization.test.ts`
- `src/tests/core/integration/preview-api-auth.test.ts`
- `src/tests/core/integration/runtime-persistence.test.ts`
- `src/tests/core/integration/runtime-snapshot-api.test.ts`
- `src/tests/core/integration/runtime-snapshot-smoke.test.ts`
- `src/tests/core/integration/runtime-state-source.test.ts`
- `src/tests/core/integration/system-readiness.test.ts`
- `src/tests/core/orchestration/execution-verification-evidence-runtime.test.ts`
- `src/tests/core/orchestration/feature-access-gate-persistence-failure.test.ts`
- `src/tests/core/orchestration/feature-access-gate-runtime.test.ts`
- `src/tests/core/orchestration/multi-task-mission-runtime.test.ts`
- `src/tests/core/orchestration/negative-execution-path-runtime.test.ts`
- `src/tests/core/orchestration/orchestration-execution-engine-binding.test.ts`
- `src/tests/core/orchestration/resume-after-approval-crash-recovery.test.ts`
- `src/tests/core/orchestration/resume-after-approval-cross-instance-concurrency.test.ts`
- `src/tests/core/orchestration/resume-after-approval-cross-process-concurrency.test.ts`
- `src/tests/core/orchestration/resume-after-approval-cross-tenant-audit-collision.test.ts`
- `src/tests/core/orchestration/resume-after-approval-evidence-persistence-failure.test.ts`
- `src/tests/core/orchestration/resume-after-approval-final-audit-persistence-failure.test.ts`
- `src/tests/core/orchestration/resume-after-approval-legacy-user-scope.test.ts`
- `src/tests/core/orchestration/resume-after-approval-mission-persistence-failure.test.ts`
- `src/tests/core/orchestration/resume-after-approval-multi-task.test.ts`
- `src/tests/core/orchestration/resume-after-approval-plan-linkage.test.ts`
- `src/tests/core/orchestration/resume-after-approval-recovery-audit-persistence-failure.test.ts`
- `src/tests/core/orchestration/resume-after-approval-result-persistence-failure.test.ts`
- `src/tests/core/orchestration/resume-after-approval-task-persistence-failure.test.ts`
- `src/tests/core/orchestration/resume-after-approval-verification-persistence-failure.test.ts`
- `src/tests/core/persistence/cross-process-stale-write.test.ts`
- `src/tests/core/persistence/json-file-adapter-crash-lock.test.ts`
- `src/tests/core/persistence/json-file-adapter-incomplete-lock.test.ts`
- `src/tests/core/persistence/supabase-runtime-snapshot.test.ts`
- `src/tests/core/state/scoped-snapshot.test.ts`
- `src/tests/core/verification/execution-status-verification.test.ts`
- `src/tests/core/verification/module-route-semantic-verification.test.ts`
- `src/tests/core/workspace/canonical-tenant-diagnostic-route.test.ts`
- `src/tests/core/workspace/execute-route.contract.test.ts`
- `src/tests/core/workspace/file-backed-state.test.ts`
- `src/tests/core/workspace/live-dashboard.test.ts`
- `src/tests/core/workspace/live-state-service.test.ts`
- `src/tests/core/workspace/supabase-tenant-resolver-readonly.test.ts`
- `src/tests/core/workspace/system-features-route.test.ts`
- `src/tests/core/workspace/tenant-diagnostic-route.test.ts`
- `src/tests/core/workspace/workspace-tenant-registry-cross-process-concurrency.test.ts`
- `src/tests/core/workspace/workspace-tenant-registry-integrity.test.ts`
- `src/tests/core/workspace/workspace-tenant-registry-lock-failure.test.ts`
- `src/tests/server/canonical-tenant-live.test.ts`
- `src/tests/server/supabase-auth.test.ts`

### Supabase migrations and tests (remaining 4)
- `supabase/migrations/20260917000000_happy_core_schema_rls.sql`
- `supabase/migrations/20260919000100_happy_runtime_snapshots.sql`
- `supabase/migrations/20260925000100_happy_module_records.sql`
- `supabase/tests/happy_core_rls.test.sql`

## Main-only paths (2)
- `HAPPY-AI-SOURCE-REVIEW.zip`
- `README.md`

## Shared paths (177)

Every path in the `main` tree other than the two main-only paths above is also present in the candidate. Therefore the shared set is exactly `main paths minus the two main-only paths`. This document does not claim byte-for-byte identity for those shared files.

## Interpretation and next steps

1. Candidate is a substantially expanded source tree, not a replacement snapshot of `main`: it adds 185 paths, including 25 app pages/routes, 55 core runtime files, 84 tests, and Supabase config/migrations.
2. The candidate adds an authenticated App Router/Supabase/runtime surface that is absent from `main`'s current 179-blob tree. That makes it a large feature integration, not a small security patch.
3. Two existing main files are absent from the archive; preserve them unless there is a separately reviewed reason to replace/remove them.
4. Before importing source, hash-compare all 177 shared files and produce a semantic diff for every changed file. Prioritize root manifests/config, auth, route handlers, persistence, execution adapters, and migrations.
5. Keep candidate files as the reference source until the exact merge plan and test results are reviewed. No merge, DB write, migration application, or deployment is authorized by this inventory.
