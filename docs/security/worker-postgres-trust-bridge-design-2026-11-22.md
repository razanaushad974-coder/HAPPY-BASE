# HAPPY worker-to-PostgreSQL trust bridge — design gate (2026-11-22)

## Decision

Do not pass a Vercel OIDC token directly to Supabase Auth/PostgREST and do not turn a web application's service_role key into worker identity. Vercel's workload subject is not a Supabase auth.uid() UUID. Keep the worker principal and the original human tenant actor as separate authorities.

The current scheduler SQL remains a design-only candidate. All worker-facing scheduler/reconciliation RPC grants remain revoked. This document is an implementation design and security gate, not an authorization to provision infrastructure, apply SQL, create credentials, or deploy.

## Trust domains

1. Hosting workload — a separately provisioned worker project obtains a fresh Vercel OIDC token through the supported server-side request-context helper. It never accepts a token from request headers, query parameters, body fields, or a caller-controlled forwarded header.
2. Identity broker — a server-only broker validates the OIDC signature against the pinned issuer JWKS and validates exact issuer, audience, subject, owner ID, project ID, environment, iat, nbf, exp, and token lifetime. It also checks the worker registry status and capability allowlist. It does not trust caller-supplied worker labels.
3. Database connection — the broker uses a dedicated, least-privilege PostgreSQL login/connection identity, separate from Supabase anon, authenticated, and broad service_role. The database authorization boundary is the authenticated database principal (session_user/role membership), not a mutable custom GUC or a worker ID passed as an RPC argument.
4. Tenant authorization — the original requester/executor, tenant membership, founder approval, request digest, task/mission binding, and approval evidence are loaded from persisted records and checked transactionally. The worker never supplies or impersonates the human actor.

## Database principal and privilege model

- Prefer an isolated worker broker database role (or one role per separately revocable worker class) with LOGIN disabled by default until provisioning is approved.
- Grant that role only CONNECT to the intended database, USAGE on a private worker API schema, and EXECUTE on the exact worker RPC allowlist. Do not grant table ownership, direct table DML, schema-wide defaults, BYPASSRLS, superuser, or membership in service_role.
- Revoke worker RPC execution from PUBLIC, anon, authenticated, and service_role; then grant only to the dedicated worker database role after review.
- Every privileged worker function must be SECURITY DEFINER only where required, use a fixed safe search_path, schema-qualify objects, validate all arguments, and have a narrowly controlled owner that is not the worker login.
- Inside privileged functions, derive the workload principal from the authenticated database session role (for example session_user) and map it to an enabled registry row. Never accept p_owner_id, p_worker_id, JWT custom claims, current_setting('request.jwt.claim.sub'), or arbitrary set_config values as proof of worker identity.
- Ensure the broker connection cannot execute arbitrary SQL on behalf of a caller. The broker exposes typed operations only; no generic SQL endpoint, arbitrary query passthrough, or client-controlled role switching.
- If Supabase's hosted connection model cannot preserve and expose a distinct authenticated database principal end-to-end, stop and use a separately managed PostgreSQL worker database/broker boundary. Do not emulate a principal with a caller-settable session variable.

## Worker registry and revocation

A private registry should bind:
- stable worker principal (exact issuer + exact subject + environment);
- owner/project identifiers and expected audience;
- allowed capabilities and permitted RPC operation set;
- enabled/disabled state, activation window, and credential/key version;
- audit metadata and revocation reason/time.

Registry writes are restricted to an operator-controlled provisioning path, not the worker role. A token is rejected if the registry entry is absent, disabled, expired, or mismatched. Revocation must disable the registry entry and invalidate broker-side cached authorization promptly; rotate/revoke the database credential or role when the worker runtime itself is compromised. Never rely on short JWT expiry as the only revocation mechanism.

## Replay, idempotency, and lease fencing

- Treat OIDC jti (or a token digest when jti is absent) as an audit identifier, not as replay prevention.
- Do not persist raw OIDC tokens. Keep a short-lived, hashed token identifier only if operational replay telemetry requires it; retention and privacy policy must be explicit.
- Every task claim must be atomic and tenant-scoped. The database issues lease ID, attempt, and monotonically increasing fencing token; worker-supplied owner strings are metadata only.
- Every dispatch is bound to one immutable outbox row, execution request ID, idempotency key, payload digest, capability, action, tenant scope, lease ID, and fencing token.
- A broker call must verify the worker registry capability and the persisted request's approval and tenant bindings in the same transaction as the claim/dispatch/outcome operation.
- Reject stale lease IDs, stale fencing tokens, mismatched worker principal, disabled worker, changed payload digest, duplicate conflicting idempotency key, and terminal outcome rewrites.
- A timeout after an external side effect is ambiguous. Record reconciliation evidence; do not automatically replay merely because a lease expired. Accept a late provider outcome only while the exact original lease/fence binding remains current and no replacement lease has been issued.
- Concurrent duplicate claims/outcomes must be serialized by database constraints/row locks and tested against real PostgreSQL, not only mocked application code.

## Required broker operation surface

Expose only typed, bounded operations, initially:
1. claim_task — claim an eligible task after registry/capability and tenant binding checks.
2. enqueue_dispatch — bind an approved persisted execution request to the current lease and immutable outbox.
3. record_dispatch_outcome — record one outcome for the exact outbox/lease/fence.
4. append_reconciliation_evidence and list_reconciliation_evidence — append-only evidence operations with tenant/request binding.

Do not expose generic tenant-record CRUD, unrestricted snapshot writes, arbitrary file access, arbitrary SQL, or general-purpose service_role access through this bridge.

## Mandatory adversarial verification before any grant

- A user JWT, anon, authenticated, and service_role cannot execute worker RPCs.
- A non-worker database login and a disabled/revoked worker login cannot execute worker RPCs.
- A worker cannot choose another worker principal, tenant actor, organization, workspace, approval decision, capability, or payload digest.
- A worker with one capability cannot invoke another capability's operation.
- Expired/not-yet-valid token, wrong issuer/audience/subject/owner/project/environment, unknown key, JWKS outage, revoked registry row, and excessive token lifetime fail closed.
- Replayed token IDs do not create duplicate task effects; duplicate requests are idempotent; conflicting reuse is rejected.
- Concurrent claim, lease reclaim, stale fencing token, late provider response, ambiguous timeout, and terminal outcome rewrite cases are tested.
- Tenant membership and founder approval are re-derived from persisted records, not inferred from worker identity.
- Run the full disposable PostgreSQL harness and capture the exact commit/workflow evidence. Then separately verify hosted Supabase role/function-owner/RLS behavior in an explicitly approved non-production project before considering production.
- Independent review of SQL function ownership, default privileges, connection pooling/session identity semantics, secret storage, audit retention, incident revocation, and operational break-glass procedures is required.

## Current implementation status

- Injected trusted-worker identity policy: implemented, fail-closed contract only.
- Vercel RS256/JWKS verifier: implemented and CI-verified on the current branch; no production token source configured.
- Dedicated Vercel worker project/runtime: NOT_YET_CONNECTED.
- Worker registry/revocation store: NOT_IMPLEMENTED.
- Broker with a distinct authenticated database principal: NOT_IMPLEMENTED.
- Database principal-to-worker registry binding: NOT_IMPLEMENTED.
- Replay/incident revocation operations: NOT_IMPLEMENTED.
- Hosted Supabase compatibility and grants: NOT_VERIFIED; no hosted changes.
- Scheduler and reconciliation worker grants: intentionally revoked.

## Provisioning boundary

No project, environment variable, secret, database role, migration, grant, deployment, or production resource is changed by this design. Provisioning requires explicit approval and a verified non-production target. Until every mandatory gate is satisfied, the system must report NOT_YET_CONNECTED and must not claim durable worker execution is live.
