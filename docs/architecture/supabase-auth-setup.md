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
- `src/app/api/auth/session/route.ts`: no-store session status check; it returns only AUTHENTICATED, UNAUTHENTICATED, or NOT_YET_CONNECTED and never exposes user claims.

The Proxy refreshes sessions; it is not the authorization boundary. Every server route or action that accesses private data must independently call `getVerifiedIdentity()` / `requireVerifiedIdentity()` and then validate organization/workspace membership. Do not authorize with `getSession()`, browser-supplied tenant IDs, or user-editable `user_metadata`.

## Not yet connected

- No sign-in/sign-up UI or auth callback route has been enabled.
- No organization/workspace membership schema or RLS policies have been applied.
- No Supabase persistence adapter is registered as AVAILABLE.
- No live database write, migration, auth configuration change, or Production deployment has been performed.

The current Supabase project has no application tables or migration history. Tenant schema design and migration review must precede remote persistence activation.

## Preview verification

- Preview-only Vercel variables were added for branch `happy/supabase-auth-tenant-foundation`; Production and Development targets were not changed.
- The first deployment was created before the variables were attached and returned HTTP 500. A fresh deployment after configuration returned HTTP 200 for the root route.
- The deployment used for that HTTP 200 smoke check was `dpl_9CF7E73P9o17Z45D6Cq2BYnUN7qH`.
- A follow-up build is required after adding the session status route. The route must return `UNAUTHENTICATED` for a request without a signed-in user, or `AUTHENTICATED` after a real sign-in.
