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
