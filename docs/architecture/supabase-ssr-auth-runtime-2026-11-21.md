# Supabase SSR authentication runtime — 2026-11-21

## Implementation scope

This change adds a request-scoped Supabase SSR authentication boundary to the existing Next.js 16 application. It does not claim that HAPPY's tenant model, workspace persistence, or production identity composition is complete.

## Runtime components

- `src/lib/supabase/env.ts` validates the public Supabase URL and publishable key. HTTPS is required except for localhost development.
- `src/lib/supabase/client.ts` creates the browser client.
- `src/lib/supabase/server.ts` creates a new cookie-bound server client for each server request/render. It does not store clients in module-level state.
- `src/lib/supabase/proxy.ts` refreshes the session and writes updated cookies/required cache headers. Missing environment configuration is treated as an unconfigured preview and passes through; invalid configuration fails rather than silently falling back.
- `src/proxy.ts` wires the helper into the Next.js 16 Proxy entry point.
- `src/lib/supabase/auth.ts` derives the actor only from Supabase-verified JWT claims via `auth.getClaims()`. User-editable metadata is not an authorization source.
- `src/lib/supabase/tenant.ts` bridges the request-scoped SSR client into the canonical tenant resolver. Organization/workspace IDs remain selectors; the resolver confirms both active memberships through `public.resolve_authenticated_tenant_context`, which derives the principal from `auth.uid()`. Authenticated clients receive RPC execution only; direct `private` schema/table access remains revoked.
- `GET /api/auth/session` exposes only a coarse authentication state and is explicitly non-cacheable.
- `GET /auth/callback` exchanges the PKCE code and restricts the post-login path to same-origin relative paths.
- `POST /auth/signout` checks the request Origin and signs out only the current local session.
- `/login` provides email magic-link sign-in. `/workspace` is an authenticated entry shell, not the finished Workspace OS.

## Required environment

Set these variables in the relevant local/Preview/Production environment before expecting authentication to work:

- `NEXT_PUBLIC_SUPABASE_URL`
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`

Do not place service-role keys in browser-visible environment variables. No Supabase secrets or credentials are committed by this change.

Configure the Supabase Auth Site URL and redirect allowlist to include the exact application origins and `/auth/callback` path used by each environment. Email delivery and magic-link templates must be verified independently.

## Security boundaries

1. Proxy refresh is not authorization. Every protected server page and API route must independently call the verified identity helper (or a stricter request composition boundary).
2. A verified user ID is not proof of organization/workspace membership. Never infer tenant access from JWT user metadata, email domains, client input, or an untrusted header.
3. Do not expose tenant data, execute missions, access files, or mutate business records until canonical tenant membership and capability authorization are resolved on the server.
4. The workspace page intentionally displays only the authentication boundary and states that tenant-backed capabilities are not yet connected.
5. Authenticated responses must not be shared-cached. The Proxy forwards the cache headers supplied by `@supabase/ssr`; the session endpoint is `private, no-store`.

## Verification added

- `src/tests/core/tenant/supabase-public-environment.test.ts` checks missing configuration, malformed URL, insecure remote URL, embedded URL credentials, invalid publishable key, localhost HTTP, and normalized HTTPS URL.
- The test is included in `npm run test:security`.

## Explicitly not complete

- No live Supabase schema, migration, RLS policy, membership row, or auth setting was changed.
- No production/Preview secrets were added or verified.
- Hosted JWT verification, Auth redirect allowlist, SMTP delivery, and cookie behavior still require environment-level integration tests.
- Canonical organization/workspace membership and tenant-scoped runtime composition remain separate blockers.
- Founder Dashboard, public Workspace OS modules, mission UI, Business OS, provider adapters, browser worker, connectors, billing, voice/telephony, observability, backup/restore, and production operations are not delivered by this authentication slice.

## References

- Supabase SSR client and Next.js 16 Proxy guidance: https://supabase.com/docs/guides/auth/server-side/creating-a-client
- Supabase SSR advanced session and caching guidance: https://supabase.com/docs/guides/auth/server-side/advanced-guide


## Canonical tenant request adapter follow-up

- Added `src/lib/supabase/tenant.ts` to compose the Next.js cookie-bound server client with the existing canonical tenant membership resolver.
- The helper creates a fresh server client per call and delegates identity verification plus exact organization/workspace membership checks to the existing core composition.
- This is a server-side adapter only. No page or API route is granted tenant data access merely by supplying IDs; callers must handle `UNAUTHENTICATED` and `TENANT_ACCESS_DENIED` explicitly.
- The private membership schema and deployed tables are still not confirmed in hosted Supabase. Therefore this helper is fail-closed and does not imply tenant persistence is live.
- No schema, migration, database row, or production setting was changed.

## Follow-up CI result — 2026-11-21

- The request-scoped canonical tenant adapter and workflow path-filter changes are included in commit `fbe5a0ec85d17fcb6bbb241bc4f436313da11462`.
- GitHub Actions run `44894035617` completed successfully. All 22 validation steps passed, including TypeScript, security contracts, PostgreSQL RLS/CAS integration, async persistence/memory/evidence/verification contracts, mission/orchestration tests, ESLint, dependency audit, and production build.
- This is repository CI against its disposable PostgreSQL harness and test doubles. It is not a hosted Supabase deployment or live-tenant integration test.
- The canonical membership tables referenced by the adapter are present only in a design-only SQL candidate in this repository; their presence and policies in the connected Supabase project remain unverified. Until a reviewed migration is explicitly approved and applied, the request adapter must remain unused for tenant data access.


## Tenant membership RPC security correction — 2026-11-21

- A code/SQL contract review found that the first tenant adapter attempted direct reads from `private.organization_memberships` and `private.workspace_memberships`, while the design SQL explicitly revoked `private` schema/table access from `authenticated`. That adapter would have failed closed and could not resolve real memberships.
- Replaced the two direct membership reads with one `public.resolve_authenticated_tenant_context(uuid,uuid)` RPC. It derives the principal from `auth.uid()`, checks active organization, workspace, and both membership records, and returns only the caller's exact membership roles.
- The RPC is executable by `authenticated` only; execution is revoked from `public`, `anon`, and `service_role`. It does not grant direct `private` schema or table access.
- Added standalone design-only SQL candidate `supabase/drafts/20261121_authenticated_tenant_context_rpc_candidate.sql`.
- Changed the core membership store to resolve the exact organization/workspace pair in one RPC, reducing split-read inconsistency. The adapter cross-checks the returned user ID against the separately verified `auth.getUser()` identity and checks exact scope values.
- Extended request-composition and store contract tests for one-call behavior, no caller-supplied user ID, revoked/missing memberships, mismatched principal, and RPC errors.
- Extended the disposable PostgreSQL harness to check active-member resolution, revoked-member denial, and privilege boundaries. This harness uses a local `auth.uid()` claim stub; it is not hosted Supabase JWT/RLS verification.
- The SQL remains a draft candidate and has not been applied to any Supabase project. The Next.js tenant helper remains unwired to tenant-data routes pending migration approval and hosted integration verification.

### RPC implementation verification — 2026-11-21
- The first direct-table membership adapter was removed because the private-schema SQL design explicitly revokes direct schema/table access from `authenticated`.
- The canonical resolver now calls one RPC for the exact organization/workspace pair. The SQL candidate derives the principal from `auth.uid()`; no user ID is accepted as an RPC argument. The application verifies that the returned user ID matches the separately verified `auth.getUser()` principal.
- The RPC checks active organization, active workspace, active organization membership, active workspace membership, and nonblank roles. It returns no row for missing/revoked/inactive membership.
- Added PostgreSQL harness assertions for successful active membership, revoked-member denial, authenticated-only RPC execution, and continued denial of direct private-schema/table access.
- This RPC is still a design-only candidate. The harness uses a local claim stub, and the SQL must be reviewed and explicitly approved before any hosted Supabase migration.
### Tenant context RPC function-owner hardening — 2026-11-21
- Review confirmed that the disposable PostgreSQL harness previously executed the SECURITY DEFINER tenant context RPC under the migration/test superuser owner. That proved the query and grants but did not prove the intended least-privilege function-owner boundary.
- The harness now transfers the RPC to a dedicated NOLOGIN BYPASSRLS role with USAGE only on private and auth, SELECT only on the four organization/workspace/membership tables, and EXECUTE on auth.uid(). It asserts the role has no membership-table write privileges and that only authenticated can execute the public RPC.
- The SQL candidate now documents this owner model as a deployment gate. Do not use service_role as the function owner. The target Supabase project must be checked for role-creation/ownership permissions and the actual table/RLS ownership model before any migration.
- This remains a local PostgreSQL role simulation with a stubbed auth.uid() claim, not hosted Supabase JWT/RLS proof. No migration was applied and no production data was changed.
### Named-executor durable request lookup — 2026-11-21
- Review found the named-executor provider's durable request store querying private.execution_requests directly through a generic private-schema client. That conflicted with the candidate's revoked authenticated private-schema/table grants and could not safely establish which executor owned a guessed request ID.
- Replaced the direct query with resolve_authenticated_execution_request(text), a user-scoped RPC that derives the executor from auth.uid(), returns only the matching READY request, and accepts only the opaque request ID. The application adapter fails closed on errors, zero/multiple rows, or malformed fields.
- Added a dedicated NOLOGIN BYPASSRLS function owner with SELECT-only access to private.execution_requests and EXECUTE on auth.uid(); the SQL candidate revokes RPC execution from public/anon/service_role and grants it only to authenticated.
- The PostgreSQL harness now checks exact executor success, guessed foreign request denial, different-user denial, non-READY denial, SELECT-only owner privileges, and RPC grants. The local auth.uid() claim remains a stub, not hosted Supabase JWT proof.
- The adapter is still not wired into production runtime composition; the SQL remains a design-only candidate and has not been applied.

### Named-executor grant consumption boundary hardening — 2026-11-21

- The grant lookup adapter also exposed a legacy direct private-table UPDATE implementation for consumption. Although the SQL candidate revokes API-role table writes and the production-shaped store uses the user-scoped RPC, retaining a second consume path made accidental privileged-client composition possible and contradicted the database boundary.
- Disabled direct grant consumption in `SupabaseNamedExecutorGrantStore`. It remains a lookup adapter only in effective behavior; `consumeApprovedGrant` now fails closed without issuing a table UPDATE.
- The only supported application consume path is `SupabaseTransactionalNamedExecutorGrantStore` with a request-scoped, user-JWT RPC client calling `consume_file_mutation_approval_grant`. The database derives executor identity from `auth.uid()` and performs the atomic exact-binding transition.
- Updated the store contract test to assert no private-table UPDATE or table access occurs through the legacy method. Existing transactional RPC tests continue to verify exact arguments and fail-closed responses.
- This is source-level hardening only. The RPC SQL remains a design candidate; the runtime composition is not wired, no hosted migration was applied, and no live grant was read or changed.
