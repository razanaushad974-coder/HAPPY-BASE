# Supabase Auth and Tenant Foundation — Implementation Plan

## Confirmed target

- Supabase project: `razanaushad974PANDA`
- Project ref: `hsuxeebljhjwyxeuztzz`
- Region: `ap-northeast-2`
- Database: PostgreSQL 17
- Project status: `ACTIVE_HEALTHY`

## Read-only baseline (2026-11-16)

- No application tables found in the `public` schema.
- No applied database migrations are recorded.
- No Edge Functions are deployed.
- Supabase Auth infrastructure is present; this alone does not prove HAPPY application authentication is wired.
- Security advisor reports a warning for `public.rls_auto_enable()`, a SECURITY DEFINER event-trigger function with broad EXECUTE grants. Inspect its actual invocation behavior and intended use before changing it. Do not disable or alter it as part of an unrelated migration.

No SQL writes, migrations, auth configuration changes, or deployments were performed.

## Existing HAPPY contracts to preserve

- One HAPPY identity and one shared intelligence/memory model.
- Tenant scope in the current core is `organizationId`, `workspaceId`, and optional `userId`.
- Persistence entities include users, workspaces, projects, commands, missions, tasks, executions, verifications, evidence, memories, approvals, and audit events.
- Existing persistence is file-backed; the provider registry currently marks Supabase as `NOT_YET_CONNECTED`.
- Do not replace or narrow the existing orchestration, memory, approval, verification, or execution modules to add Supabase.

## Proposed implementation phases

1. **Auth boundary:** add request-scoped browser/server Supabase clients using cookie-based SSR. Validate server-side identity with `auth.getClaims()`; never authorize using user-editable user metadata or an unverified session object.
2. **Tenant resolution:** define the canonical organization/workspace membership model and map authenticated users to the existing HAPPY `TenantScope`. Do not trust organization/workspace IDs supplied by a browser without a membership check.
3. **Persistence adapter:** implement a Supabase-backed adapter behind the existing persistence contracts. Preserve the current file adapter for local development and fallback; do not claim remote persistence is active until a remote read/write round trip and tenant-isolation checks pass.
4. **Schema and RLS:** create versioned migrations for profiles, organizations, workspaces, memberships, and runtime snapshots only after the identifier and membership contracts are finalized. Enable RLS on every exposed table; policies must enforce both authentication and tenant membership. Avoid public SECURITY DEFINER helpers.
5. **Founder access:** keep founder-only operations behind server-verified identity and explicit founder authorization. Never infer founder privileges from user-editable metadata.
6. **Verification:** test unauthenticated denial, cross-user denial, cross-workspace denial, stale snapshot/version conflicts, and authorized owner/founder access. Run Supabase security advisors after schema changes.

## Important platform compatibility notes

- New Supabase projects no longer automatically expose newly created public tables through the Data API. Any required API grants must be explicit and paired with RLS.
- Next.js 16 uses `proxy.ts` for session refresh. Supabase SSR must use request-scoped clients and preserve the cache headers emitted during cookie refresh.
- The Supabase project must not receive schema changes from this preparation branch. Database migration application requires a separate explicit approval after SQL review.

## Current work branch

`happy/supabase-auth-tenant-foundation`, created from `happy/server-verified-pipeline-approval`. Production branch and live database remain unchanged.
