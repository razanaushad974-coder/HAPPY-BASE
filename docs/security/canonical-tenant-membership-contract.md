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



## Role and durable-request implementation addendum (2026-11-19)

The connected Supabase project currently has no HAPPY application membership or execution-request tables. The core resolver is therefore not yet backed by an authoritative source. Before implementing the store:

- Introduce explicit organization/workspace lifecycle and membership records with ACTIVE/SUSPENDED/REVOKED states.
- Define canonical role allowlists and a reviewed mapping to FOUNDER/ADMIN. A nonblank role string alone is not authorization.
- Add a durable execution-request record. The current `ExecutionRequest` TypeScript interface is runtime input and is not proof of requester identity.
- Resolve executor from verified server session; load requester from the durable request; load approver from persisted grant; revalidate all three independently.
- Keep all membership/grant/audit tables in a non-exposed schema with no direct client grants. Any privileged server adapter must still enforce exact tenant filters.

The proposed tenant key type is UUID (matching `auth.users.id` for user references), but no app tenant IDs currently exist in this project. This remains a proposal until confirmed and migrated. No database changes were made.
