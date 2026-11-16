# HAPPY Supabase Auth setup

This branch adds the cookie-based Supabase SSR client boundary for the existing Next.js 16 App Router application.

## Required Vercel environment variables

Set these in the intended Preview environment before testing sign-in:

- `NEXT_PUBLIC_SUPABASE_URL`: the Supabase project URL.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: the project's publishable key (`sb_publishable_...`).

The publishable key is designed for browser use. Never add a Supabase secret key or legacy `service_role` key to a `NEXT_PUBLIC_*` variable, browser code, source control, or build arguments.

Local development uses the same names in an ignored `.env.local` file. Do not commit that file.

## Added integration boundary

- `src/lib/supabase/client.ts`: browser client.
- `src/lib/supabase/server.ts`: request-scoped server client using Next.js async cookies.
- `src/lib/supabase/proxy.ts` and `src/proxy.ts`: refresh cookie-backed sessions with `auth.getClaims()`, preserving refreshed cookies and cache headers.
- `src/lib/supabase/auth.ts`: server-side verified identity helpers.

The Proxy refreshes sessions; it is not the authorization boundary. Every server route or action that accesses private data must independently call `getVerifiedIdentity()` / `requireVerifiedIdentity()` and then validate organization/workspace membership. Do not authorize with `getSession()`, browser-supplied tenant IDs, or user-editable `user_metadata`.

## Not yet connected

- No sign-in/sign-up UI or auth callback route has been enabled.
- No organization/workspace membership schema or RLS policies have been applied.
- No Supabase persistence adapter is registered as AVAILABLE.
- No live database write, migration, auth configuration change, or Production deployment has been performed.

The current Supabase project has no application tables or migration history. Tenant schema design and migration review must precede remote persistence activation.
