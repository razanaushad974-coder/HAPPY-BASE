# Vercel workload identity integration decision — 2026-11-22

## Decision

Use Vercel OIDC as a candidate workload-attestation mechanism for a separately deployed HAPPY worker service, not as proof that the current interactive HAPPY web application is itself a dedicated execution worker.

No Vercel project, environment setting, deployment, secret, database grant, or production resource was changed during this review.

## Platform facts verified

Vercel documents that its OIDC provider issues short-lived tokens to Vercel Functions and that a function invocation receives the token in request context through `x-vercel-oidc-token`. The supported Node helper is `getVercelOidcToken()` from `@vercel/oidc`; the current documentation says it reads the request-context token first and supports configured token-file/environment fallback. Do not cache the token.

Vercel's documented token claims include:
- `iss`: `https://oidc.vercel.com/[TEAM_SLUG]` for team issuer mode, or `https://oidc.vercel.com` for global issuer mode (custom audience forces team issuer).
- `aud`: defaults to `https://vercel.com/[TEAM_SLUG]`; may be set to a custom audience through the helper.
- `sub`: exact form `owner:[TEAM_SLUG]:project:[PROJECT_NAME]:environment:[ENVIRONMENT]`.
- `iat`, `nbf`, `exp`, plus `owner_id`, `project_id`, and `environment`.

Vercel instructs custom API operators to validate signature and claims using the issuer's published JWKS; do not decode the JWT payload and treat it as verified identity.

Sources:
- https://vercel.com/docs/oidc
- https://vercel.com/docs/oidc/reference
- https://vercel.com/docs/oidc/api
- https://github.com/vercel/vercel/tree/main/packages/oidc

## HAPPY project discovery

The authenticated Vercel team context exposed two Git-linked projects for `razanaushad974-coder/HAPPY-BASE`:
- `happy-base` — Next.js project.
- `happy.digi` — Next.js project.

Neither project is identified as a dedicated execution worker. The inspected `happy-base` environment-variable metadata showed preview-only Supabase public configuration; no worker-specific runtime configuration was identified. This metadata review did not decrypt or expose secret values. No dedicated worker project or worker deployment was established by this review.

## Why the existing web project is not accepted as the worker principal

A Vercel OIDC token identifies the Vercel project/environment workload. A token obtained during an ordinary web-function invocation proves that the function runs within that project/environment; it does not prove that the invocation is a dedicated background worker, that a human-triggered request is authorized for a particular task, or that a caller-supplied `owner_id`/worker label is genuine.

Therefore:
- Do not enable scheduler RPCs for the existing general web app merely because its Vercel function can obtain an OIDC token.
- Do not trust `x-vercel-oidc-token` copied from an arbitrary client header or request body. Obtain it only through Vercel's supported request-context helper inside the trusted function runtime.
- Do not infer per-task capabilities from OIDC claims. Capabilities must be server-side policy attached to the exact worker project/subject and checked against the task's approved capability.
- A dedicated worker deployment/service must have a distinct project subject, environment, route/queue trigger, and least-privilege capability policy. It must not expose a general public endpoint that turns arbitrary callers into worker invocations.

## Required integration sequence

1. Provision or select a dedicated worker runtime/project under the intended Vercel team. This is an external resource change and was not performed here.
2. Enable/configure Vercel OIDC federation for that worker project and choose a stable issuer mode.
3. Set a dedicated audience for HAPPY worker authentication.
4. Implement a server-only credential source using `getVercelOidcToken({ audience })`; never cache the token.
5. Implement a `jose` remote-JWKS verifier pinned to the exact issuer and audience. Validate RS256/key ID through the JWKS verifier, exact subject, `project_id`, `owner_id`, environment, `iat`, `nbf`, `exp`, and a strict maximum token age/lifetime. Fail closed on unknown keys, network errors, issuer mismatch, audience mismatch, or unexpected claims.
6. Map the verified Vercel subject into the existing `workload:` principal namespace. Add the worker's capability set from trusted server configuration, not from caller input.
7. Bind the verified project principal to a server-owned worker registry and a least-privilege DB function owner. The database must derive worker identity from a cryptographically verified assertion or an authenticated broker channel; a caller-supplied owner string is not sufficient.
8. Keep human Supabase `auth.uid()` membership verification separate from worker identity. If a task is user/tenant-authorized, verify the persisted tenant membership and approval grant independently, then atomically bind that authorization to the task claim/outbox record.
9. Add adversarial tests for token replay/expiry, wrong project/team/environment, wrong audience/issuer, forged worker label, unauthorized capability, tenant mismatch, missing/revoked approval, stale fencing token, and concurrent duplicate claims.
10. Only after all above gates pass may the dedicated worker function receive least-privilege execution grants. Do not grant `authenticated`, `anon`, or broad `service_role` access.

## Current status

- Core policy contract: implemented in `src/core/mission/trusted-worker-identity.ts`.
- Contract regression tests: implemented and included in `test:security`.
- Concrete Vercel token source: NOT_YET_CONNECTED.
- Cryptographic Vercel JWKS verifier: NOT_YET_CONNECTED.
- Dedicated worker project/runtime: NOT_YET_CONNECTED.
- Worker registry and database principal binding: NOT_YET_CONNECTED.
- Scheduler RPC grants: intentionally revoked from `PUBLIC`, `anon`, `authenticated`, and `service_role`.
- Hosted Supabase: unchanged.
- Vercel projects/deployments: unchanged.

The generic injected identity contract remains useful for future worker runtimes, but it is not production authentication until the dedicated Vercel worker and verifier are connected and tested.
