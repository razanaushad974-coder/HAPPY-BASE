# Candidate/Main complete shared-file content hash comparison — 2026-11-18

## Result

The complete content hash comparison has now been performed for all 177 shared paths between the uploaded candidate ZIP and GitHub `main` at commit `5ac91e870f2fc4a79d57a75d55eab5bcb099a1d1`.

- Shared paths checked: **177 / 177**
- Byte-identical Git blob hashes: **13**
- Content-different Git blob hashes: **164**
- Hash method: Git blob SHA-1 (`SHA1("blob " + byte_length + NUL + file_bytes)`) computed directly from the candidate ZIP, compared with each `main` tree blob SHA.
- This is an exact byte-level comparison, not a semantic diff of all 164 changed files.

## The 13 byte-identical shared files

- `AGENTS.md`
- `CLAUDE.md`
- `next.config.ts`
- `postcss.config.mjs`
- `public/file.svg`
- `public/globe.svg`
- `public/next.svg`
- `public/vercel.svg`
- `public/window.svg`
- `src/app/favicon.ico`
- `src/app/globals.css`
- `src/app/layout.tsx`
- `src/app/page.tsx`

## The 164 content-different shared files

All remaining shared paths are content-different. The exact set is:
- Every shared path from the complete path inventory `candidate-main-complete-path-inventory-2026-11-18.md`
- Excluding the 13 byte-identical paths listed above.

This definition is exact and unambiguous because the shared path set is exactly the 179 `main` blobs minus `README.md` and `HAPPY-AI-SOURCE-REVIEW.zip`.

High-impact changed files confirmed by direct hash comparison include:
- Root/config: `.gitignore`, `eslint.config.mjs`, `package.json`, `package-lock.json`, `tsconfig.json`
- Identity/config: `src/config/happy.ts`
- Core AI/API/approval/billing/build/change-control/command/context/evidence modules
- All shared execution adapters, including FILE, DATABASE, API and BROWSER
- Shared orchestration, persistence, state, reasoning, repair, sandbox, usage, verification, workspace modules
- Existing tests in AI/API/approval/billing/build/command/context/execution/files/founder/knowledge/memory/mission/orchestration/persistence/reasoning/repair/sandbox/state/usage/verification/workspace

## Consequence

The candidate is not a small overlay on `main`. Of the 177 overlapping files, 164 differ at the byte level. Only 13 are identical. Combined with 185 candidate-only paths and 2 main-only paths, this is a broad source-lineage divergence.

Do not merge the archive wholesale, copy the candidate tree over `main`, or assume the shared core modules are backward-compatible. Each of the 164 changed files needs semantic review and a deliberate keep/replace/merge decision. Prioritize package/config, identity, orchestration, execution adapters, persistence, API routes, Supabase migrations, and tests.

## Validation limits

- This comparison verifies byte identity/difference only; it does not determine whether a changed file is better, safer, or compatible.
- The complete semantic review of all 164 changed files remains pending.
- Full install, typecheck, lint, audit, full test suite, and production build remain unverified.
- No source code was imported into `main`; no database migration or production deployment was performed.
