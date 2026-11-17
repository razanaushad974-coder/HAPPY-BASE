# HAPPY candidate source integration sequence — 2026-11-17

## Decision
Do not replace GitHub `main` with the uploaded candidate archive. Integrate only through a dedicated implementation branch after path reconciliation and compatibility gates. This document is a proposed sequence, not authorization to merge, deploy, or modify a database.

## Phase 0 — immutable baselines
1. Record the exact GitHub base commit and candidate archive SHA-256.
2. Preserve GitHub-only files (at minimum the two omissions already confirmed: `README.md` and `HAPPY-AI-SOURCE-REVIEW.zip`).
3. Preserve a read-only copy of the candidate archive and its extraction.
4. Produce the complete MAIN_ONLY / CANDIDATE_ONLY / IDENTICAL / CONFLICT path matrix, including Git blob hashes and byte sizes. No import begins until this is complete.

## Phase 1 — resolve shared-core conflicts
Review semantic diffs and tests before selecting or combining implementations for:
- orchestration engine and orchestrator;
- execution registry, engine, default registry, adapters, workspace code executor, and capability resolver;
- persistence state, types, service, provider registry, serialization, repositories, and adapters;
- founder / founder-OS / mission / workspace contracts and services;
- configuration, TypeScript, ESLint, package manifest, and lockfile.

The exact verified conflict set is recorded in `candidate-runtime-tenant-review-2026-11-17.md`. Other overlapping paths must not be assumed identical or conflicting until hashes are compared.

## Phase 2 — dependency and schema foundation
1. Resolve the Next.js and matching ESLint dependency security update using a reachable package registry; regenerate the candidate lockfile from the candidate manifest.
2. Review environment variable names and ensure no secret key is referenced by browser/client modules.
3. Review migrations in timestamp order:
   - `20260917000000_happy_core_schema_rls.sql`
   - `20260919000100_happy_runtime_snapshots.sql`
   - `20260925000100_happy_module_records.sql`
4. Resolve finding T-01 (runtime snapshot tenant integrity) with a forward-only migration design and tests. Validate existing data shape and FK compatibility before proposing execution.
5. Keep all migration execution out of this review phase. Require explicit approval for any connected database write.

## Phase 3 — server runtime and identity
Integrate and test as one unit:
- Supabase server/browser client construction;
- authenticated runtime context and local-development fallback;
- canonical tenant resolver and tenant diagnostics;
- runtime snapshot adapter, CAS behavior, smoke endpoint, and runtime-state loading;
- founder identity/access policy and founder execution route.

Required negative tests:
- unauthenticated request;
- invalid/expired access token;
- missing or ambiguous canonical tenant;
- mismatched authenticated user;
- local-dev mode disabled in production;
- cross-tenant snapshot insert/update/read attempts;
- stale snapshot version / CAS conflict;
- Supabase unavailable or malformed scope.

## Phase 4 — approval lifecycle
Integrate as one cohesive feature:
- approval expiry policy;
- approval creation and persistence;
- decision mutation and audit event;
- approval decision API GET/POST;
- founder authorization;
- CAS snapshot persistence;
- resume-after-approval continuation and crash/concurrency recovery.

Required invariants:
- expiry is enforced in the mutation layer, not only UI/API;
- malformed expiry fails closed;
- duplicate decisions cannot mutate state twice;
- authorization/linkage validation precedes persistence;
- decision persistence and continuation recovery are distinguishable;
- a saved decision is never silently re-applied after a resume failure.

## Phase 5 — module runtime and UI
Only after server and tenant foundations pass:
- module persistence and runtime bridge;
- module registry / capability binding / routing;
- module APIs and system diagnostics;
- login, workspace, approvals, system, and smoke-test UI routes.

Do not expose smoke/diagnostic routes as production capabilities without explicit access controls and safe response shaping.

## Phase 6 — verification and release
On the integrated branch:
1. clean dependency install;
2. typecheck;
3. lint;
4. focused tests per phase;
5. complete Vitest suite;
6. npm audit and dependency review;
7. production build;
8. preview deployment only after branch checks pass;
9. manual security review of auth/RLS and approval flows.

Production deployment, database migration execution, and merge to `main` remain separate approval gates.

## Current blockers
- Full path matrix is not yet complete.
- Multiple verified same-path conflicts remain unresolved.
- Next.js 16.3.5 dependency upgrade is blocked by package-registry DNS resolution failure (`EAI_AGAIN`).
- Full install, typecheck, lint, complete tests, npm audit, and production build are not verified.
- Static tenant review identified finding T-01; no database migration has been designed/applied yet.

## Current safety status
Review branch only. No application source imported, no `main` changes, no database writes or migrations, no deployment, and no merge.


### Newly confirmed integration blocker — C-01
Semantic comparison found that the candidate database adapter weakens `main`'s fail-closed write approval rule. Candidate currently permits a write to reach its provider when `requiresApproval=false`, even if `approved=false`. The existing `main` condition blocks when either approval is not required or not granted. This must be corrected and tested across every DB write action and transaction before candidate database runtime can be integrated. See the detailed C-01 finding in `candidate-runtime-tenant-review-2026-11-17.md`.

The candidate's realpath/symlink/hard-link path checks are stronger than `main`'s lexical-only check, but a local TOCTOU race remains a residual risk. Candidate default registry also changes live capabilities by registering Supabase database and safe-shell adapters; provider auth, tenant scope, RLS, query restrictions, transaction validation, and shell policy require separate verification.


### Additional security gates — C-05 / C-06
Static review also found the candidate safe-shell adapter trusts `input.approved` from its own payload rather than binding authorization to the trusted request / persisted approval context. Do not enable safe shell until that bypass is removed and forged-approval tests pass. The Supabase database provider authenticates the bearer token and checks optional user scope, but does not independently validate organization/workspace membership; it relies on table RLS. Require negative cross-tenant tests for every reachable table and prevent unintended unfiltered UPDATE/DELETE. Keep raw query and transaction actions disabled until their safe provider layers exist. See C-05 and C-06 in the runtime tenant review.
