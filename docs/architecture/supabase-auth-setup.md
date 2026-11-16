# HAPPY Supabase Auth setup

This branch adds the cookie-based Supabase SSR client boundary and an email magic-link sign-in flow for the Next.js 16 App Router application.

## Required Vercel environment variables

Set these in the intended Preview environment before testing sign-in:

- `NEXT_PUBLIC_SUPABASE_URL`: the Supabase project URL.
- `NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY`: the project's publishable key (`sb_publishable_...`).

The publishable key is designed for browser use. Never add a Supabase secret key or legacy `service_role` key to a `NEXT_PUBLIC_*` variable, browser code, source control, or build arguments.

Local development uses the same names in an ignored `.env.local` file. Do not commit that file.

## Auth redirect configuration required in Supabase

Before a real email sign-in can complete, add the exact Preview deployment origin and local development origin (if used) to Supabase Auth URL Configuration → Redirect URLs. The callback path is:

- `https://<this-preview-host>/auth/callback`
- `http://localhost:3000/auth/callback` (local development only)

Set the Supabase Site URL to the intended canonical application URL only after that URL is decided. Auth settings are not changed by this code commit. Email delivery/provider and email templates must also be enabled/configured in the Supabase dashboard; the default confirmation template must preserve the `{{ .ConfirmationURL }}` link.

## Added integration boundary

- `src/lib/supabase/client.ts`: browser client.
- `src/lib/supabase/server.ts`: request-scoped server client using Next.js async cookies.
- `src/lib/supabase/proxy.ts` and `src/proxy.ts`: refresh cookie-backed sessions with `auth.getClaims()`, preserving refreshed cookies and cache headers.
- `src/lib/supabase/auth.ts`: server-side verified identity helpers.
- `src/app/api/auth/session/route.ts`: no-store session status check; it returns only AUTHENTICATED, UNAUTHENTICATED, or NOT_YET_CONNECTED and never exposes user claims.
- `src/app/login/page.tsx`: email magic-link request UI. Supabase's default `shouldCreateUser: true` behavior allows the first user to register; user metadata is not used for authorization.
- `src/app/auth/callback/route.ts`: exchanges the one-time PKCE code for a cookie-backed session and restricts the post-login destination to a same-origin path.
- `src/app/page.tsx`: directs the root entry point to `/login`.

The Proxy refreshes sessions; it is not the authorization boundary. Every server route or action that accesses private data must independently call `getVerifiedIdentity()` / `requireVerifiedIdentity()` and then validate organization/workspace membership. Do not authorize with `getSession()`, browser-supplied tenant IDs, or user-editable `user_metadata`.

## Not yet connected

- Supabase Auth redirect allowlist, email provider/delivery, and email template have not been configured or tested.
- No organization/workspace membership schema or RLS policies have been applied.
- No Supabase persistence adapter is registered as AVAILABLE.
- No live database write, migration, Auth configuration change, or Production deployment has been performed.

The current Supabase project has no application tables or migration history. Tenant schema design and migration review must precede remote persistence activation.

## Preview verification

- Preview-only Vercel variables were added for branch `happy/supabase-auth-tenant-foundation`; Production and Development targets were not changed.
- Deployment `dpl_6YBZypGrZBK16RazH2HYxgQss4BB` built successfully and is READY.
- Its `/api/auth/session` endpoint returned HTTP 200 with `{"status":"UNAUTHENTICATED"}` when requested without a signed-in user.
- A fresh deployment and real email round-trip test are still required for the new login page and callback route.
