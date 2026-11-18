# Candidate API surface security review — 2026-11-18

## Scope

Static review of the 15 App Router API handlers present in the uploaded 362-file candidate archive. No HTTP requests were sent to a live deployment and no exploit was executed.

## HIGH — local development authentication can be enabled in production by environment misconfiguration

Evidence:
- `src/app/api/auth/local-dev/route.ts` issues the cookie `happy_local_dev_session=1` whenever `HAPPY_LOCAL_DEV_MODE === "true"`. It does not also require `NODE_ENV !== "production"`.
- `src/core/auth/supabase-runtime-context.ts` accepts that cookie and returns the fixed identity `local-dev-user` whenever `HAPPY_LOCAL_DEV_MODE === "true"`. It does not reject production explicitly.
- `src/app/api/execute/route.ts` and `src/app/api/workspace/state/route.ts` explicitly accept this local-dev identity when local-dev mode is enabled and no Supabase access token is present.
- The local-dev identity is a fixed shared user ID, not a per-browser or cryptographically authenticated identity.

Impact:
If a production deployment accidentally sets `HAPPY_LOCAL_DEV_MODE=true`, an unauthenticated visitor can POST to the local-dev route, receive the fixed local-dev cookie, and then be treated as the same local-dev user by routes that accept the fallback. This can expose or mutate the shared local-dev workspace and can reach execution paths that explicitly permit the fallback. Founder-only routes still have the separate configured founder-ID check; this finding does not claim that the fallback automatically bypasses it.

Required remediation:
1. Enforce `process.env.NODE_ENV !== "production"` in both the local-dev cookie issuer and the runtime-context fallback, in addition to the env flag.
2. Add production-mode tests with `HAPPY_LOCAL_DEV_MODE=true` proving the endpoint returns 404/disabled and the runtime context returns unauthenticated.
3. Add deployment validation that rejects `HAPPY_LOCAL_DEV_MODE=true` in production rather than relying only on operator discipline.
4. Keep the local-dev identity and fallback entirely absent from production builds/runtime.

## Other API route observations

| Route | Static observation |
|---|---|
| `POST /api/auth/local-dev` | Issues the fixed local-dev cookie under the env flag; covered by the HIGH finding above. |
| `GET /api/auth/me` | Requires a valid bearer token or Supabase cookie session; returns the current user's own id/email/role/user metadata. |
| `GET /api/capabilities` | Production-hidden unless `HAPPY_LIVE_PREVIEW=true`; when enabled in production, requires authenticated Supabase identity. |
| `POST /api/execute` | Requires Supabase auth or the conditional local-dev fallback; uses file-backed workspace state and reports remote persistence separately. |
| `POST /api/founder/execute` | Requires authenticated runtime identity and a server-configured Founder ID; separate from local-dev mode but ensure the production fallback is disabled regardless. |
| `GET /api/preview` | Production-hidden unless live preview is enabled; when enabled, requires authenticated Supabase identity. File inventory roots are fixed to `src`; Git subprocess arguments are fixed constants. |
| `GET /api/runtime/snapshot` | Requires Supabase session; resolves canonical remote scope but also bootstraps/reads file-backed local workspace state. |
| `POST /api/runtime/snapshot` | Requires Supabase session; writes the local snapshot to the remote scope with version `1`, which can overwrite/reset newer remote state. This is covered in the main candidate source review. |
| `POST /api/runtime/snapshot/smoke` | Requires Supabase session, but uses the file-backed tenant IDs directly and saves with version `1`; likely returns NOT_YET_CONNECTED/invalid scope for non-UUID local IDs and can overwrite version when the scope happens to be UUID. |
| `GET /api/approvals/decision` | Resolves canonical tenant without provisioning and checks configured Founder identity. |
| `POST /api/approvals/decision` | Same canonical identity gate; CAS persists the approval decision, but resumed state is not written back to remote snapshot (main review). |
| `GET /api/system/canonical-tenant-diagnostic` | Requires authenticated runtime identity and configured Founder identity. |
| `GET /api/system/features` | Requires authenticated runtime identity and configured Founder identity. |
| `GET /api/system/tenant-diagnostic` | Requires authenticated runtime identity and configured Founder identity. |
| `GET /api/workspace/state` | Requires Supabase auth or conditional local-dev fallback; reads user-scoped file-backed workspace data. |
| `GET /api/system/modules` | Public read-only module evidence snapshot; review returned fields to ensure no tenant/user data is included. |
| `GET /api/system/readiness` | Public read-only readiness snapshot; review returned fields to ensure no tenant/user data is included. |

## Additional notes

- `.env.example` contains empty placeholders only, including `SUPABASE_SECRET_KEY=`; this file alone does not contain a credential.
- The Supabase server client uses publishable/anon keys and cookie session context. The database provider explicitly rejects use of `SUPABASE_SECRET_KEY` as the normal user database provider key; no service-role bypass was identified in the reviewed source paths.
- Static source scan found no `eval()`, `new Function()`, `dangerouslySetInnerHTML`, direct `.innerHTML =`, disabled TLS verification, or wildcard CORS assignment in the scanned TS/TSX/JS source.
- The preview route uses `execFileSync` for Git metadata with a fixed argument list (no shell command string from user input identified in this scan).
- These observations do not replace runtime, deployment-environment, or Supabase RLS verification.

## Required next order

1. Close the production local-dev fallback gap.
2. Fix canonical tenant identity and remote snapshot CAS/version handling.
3. Fix post-approval resume remote persistence.
4. Replace caller-controlled approval booleans with server-owned, one-time authorizers for all side-effecting adapters.
5. Run the exact candidate's complete install, audit, typecheck, lint, focused and full tests, and production build.
