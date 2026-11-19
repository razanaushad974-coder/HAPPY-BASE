# Canonical tenant membership contract

## Scope

This change adds a fail-closed core resolver contract only. It does not connect Supabase, create membership tables, add routes, or activate FILE access. The resolver requires a server-verified identity and an authoritative membership-store implementation.

## Trust boundaries

- The user ID must come from a server-side verified identity provider (the auth-foundation branch uses Supabase `auth.getClaims()`).
- Requested organization/workspace IDs are selectors, not authorization evidence.
- Organization and workspace membership must be independently loaded from an authoritative store using the verified user ID and exact requested scope.
- Both memberships must be active and must match the requested user, organization, and workspace exactly.
- Workspace membership must point to the same organization whose membership was verified.
- Membership lookup errors, missing records, inactive records, blank roles, or mismatches return `null`; there is no metadata, request-body, cache, or local-tenant fallback.
- The resulting actor contains only the one organization/workspace scope verified by this resolution.

## Integration requirements still open

1. Define and review the actual organization, workspace, membership, invitation, and role schema.
2. Implement a server-only Supabase membership store with RLS and tenant isolation. Do not use service-role bypass as a shortcut.
3. Define role semantics and map organization/workspace roles to founder/admin approval policy.
4. Resolve the execution actor from the verified session; load the original requester from a durable server-owned execution request, not request JSON.
5. Separate requester, approver, and executor identities. A founder/admin approval must be attributable to the approver while later execution remains attributable to the authenticated executor.
6. Bind FILE READ path authorization to the canonical workspace root and a server-owned path policy.
7. Add database-backed integration tests for cross-tenant reads, membership revocation, concurrent grant consumption, and RLS.

## Explicit non-goals

- No SQL migration, DDL, Supabase data write, or live project change.
- No Supabase auth helper copied from the divergent branch.
- No production authorizer/store wiring; FILE READ and FILE mutations remain default-deny unless separately and correctly composed.
- No merge, production deployment, or change to `main`.
