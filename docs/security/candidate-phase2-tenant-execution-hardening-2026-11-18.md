# HAPPY candidate — phase 2 tenant execution hardening

Date: 2026-11-18

## Scope and safety boundary

This phase continues only from `HAPPY-AI-WORKING-UPDATED-security-containment-patched.zip` (SHA-256 `9b7044f4d20f03c6e15de59284c0d97019671b1184d999f15fddb7ac54b78d78`). Changes are confined to this extracted candidate. No GitHub application-source branch, `main`, production deployment, or live Supabase project was changed. No migration was applied and no live Supabase request was made by the new test.

## Implemented

### Database provider tenant membership guard

`src/core/database/supabase-database-provider.ts` now performs a tenant check after validating the Supabase access token with `auth.getUser` and before any requested table operation:

1. Resolve the exact `(workspace_id, organization_id)` pair from `public.workspaces`.
2. Deny if that workspace does not exist under the requested organization.
3. Permit the workspace owner recorded on the workspace row.
4. Otherwise require a matching `(workspace_id, authenticated user_id)` row in `public.workspace_members`.
5. Fail closed on lookup errors or missing membership.

The guard applies before SELECT and write operations, not only to mutations. Existing downstream table RLS remains an additional control; this check does not replace RLS.

A client factory seam was added to the provider constructor solely to permit deterministic isolated tests. The default remains the official `createClient` function.

## Focused verification

Added `src/tests/core/database/supabase-provider-tenant-membership.test.ts`.

- Non-member user denied: PASS.
- Workspace/organization mismatch (workspace lookup returns no row) denied: PASS.
- Test asserts the provider checks workspace and membership tables in the expected order: PASS.
- Test used an injected fake Supabase client; no live Supabase request: PASS.

This focused test was executed through TypeScript transpilation and a local Node harness because project dependencies are not installed in the isolated environment. It is not a full Vitest run or semantic TypeScript typecheck.

## Durable approval authorizer — not yet implemented

The candidate still does not provide a complete durable, one-time approval grant path. In particular:

- `ExecutionRequest` does not consistently carry an immutable server-derived actor + organization + workspace context into every adapter.
- The approval decision route persists a decision into the runtime snapshot, but the candidate has not yet established an atomic, action-bound grant record consumed by every side-effect adapter.
- A safe implementation must bind a grant to actor, tenant, request/plan, exact capability/action, normalized target/resource, input digest, expiry, and pending/approved/consumed state; consume it atomically once; and reject replay/concurrent consumption.
- The grant creation path must derive the actor from the authenticated Supabase session and the tenant from canonical server-side resolution. Request-body fields, `approved`, and `requiresApproval` cannot confer authority.
- No service-role bypass or client-selected authorizer may be introduced.

The current default-deny behavior for FILE and DATABASE writes and disabled API/BROWSER egress remains in force. Do not wire a permissive test authorizer into production composition. The approval grant schema/RPC and route/adapter integration remain a separate, coordinated change requiring migration review and complete tests.

## Validation not performed

Full `npm ci`, semantic `tsc --noEmit`, ESLint, full Vitest, `npm audit`, and production build remain unrun because dependencies were unavailable in the prior isolated environment and registry DNS failed. No claim of full build or release readiness is made.
