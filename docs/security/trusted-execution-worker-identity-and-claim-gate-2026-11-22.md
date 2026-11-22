# Trusted execution worker identity and atomic claim gate — 2026-11-22

## Existing identity-provider audit — 2026-11-22

The current `SupabaseVerifiedServerIdentityProvider` in `src/core/tenant/supabase-verified-server-identity-provider.ts` is a human-session identity adapter, not a worker-attestation adapter:

- It calls the request-scoped Supabase client's `auth.getUser()` and returns only the verified human `userId`.
- Its documented contract explicitly requires the incoming user's cookies/JWT and forbids service-role and browser clients.
- It does not verify a workload issuer, worker subject, worker audience, deployment environment, capability grant, or worker credential lifetime/revocation.
- Therefore it may continue to establish the human principal for tenant-scoped user operations, but it MUST NOT be reused or relabelled as a worker identity provider.
- The `ownerId` field in the pure `ClaimedDispatch` contract is data binding only; a string in that field is not proof of workload identity. The durable claim/RPC must bind it to an independently verified worker principal before it can authorize side effects.

This is a source-level contract audit only. It does not establish a deployed worker identity or change the current NOT_YET_CONNECTED state.

## Decision 

HAPPY does not yet have a trusted execution-worker identity. Do not expose a claim, heartbeat, dispatch, completion, or failure endpoint to ordinary authenticated user sessions. A user JWT proves the user session; it does not prove that the caller is an approved worker process.

The current execution-request API persists intent and approval only. Approval changes the durable request to READY; it is not dispatch authorization for an arbitrary caller and does not mean work has started.

## Trust boundary required before implementation

A worker identity must be established outside caller-controlled request data and outside the browser/user session. The identity verifier must provide all of the following:

- Cryptographically verified issuer, subject, audience, expiry, not-before, and key identifier; reject unsigned, expired, wrong-audience, wrong-issuer, and unknown-key credentials.
- A dedicated worker principal distinct from every human user principal; no caller-supplied worker ID may be authoritative.
- Environment and workload binding (deployment/project/environment or equivalent), with explicit allowlisting of which workload may claim which capability classes.
- Short-lived credentials, rotation/revocation, replay resistance, bounded clock skew, and auditable identity-verification failures.
- A server-only composition path. No signing key, service-role key, or worker credential may enter browser bundles, logs, PR comments, or execution payloads.
- Tenant authorization remains independently enforced in PostgreSQL. A valid worker identity alone grants no access to any tenant or request.

Acceptable identity-provider candidates for a future deployment review include a platform-signed workload identity/OIDC token with strict issuer+audience+subject verification, or a SPIFFE/SPIRE workload identity over mutually authenticated transport. A static shared secret, user Supabase JWT, request-body worker ID, unverified forwarded header, or service-role key alone is not an acceptable worker identity.

## Atomic claim transaction contract

Once a concrete worker identity provider is selected and verified, the database-owned claim operation must be one atomic transaction. It must:

1. Derive the worker principal from verified database-visible identity claims or a separately verified, short-lived worker assertion. Never trust a worker ID supplied as an ordinary SQL argument.
2. Require the request to be READY, approved, not cancelled, and bound to an exact active organization/workspace, mission, task, capability, action, immutable input digest, and envelope digest.
3. Check the worker principal is active and explicitly permitted for the requested capability and deployment environment.
4. Conditionally transition READY to RUNNING exactly once, setting worker principal, lease expiry, attempt number, monotonically increasing fencing token, and claim timestamp in the same transaction.
5. Return the immutable envelope and claim token only to the worker that won the conditional transition. Concurrent claimants must receive no executable payload.
6. Bind a stable dispatch/idempotency key to the complete immutable envelope and logical attempt. Reuse with a different envelope must fail.
7. Append claim evidence atomically. Evidence must include worker principal, exact tenant/request/task/mission, attempt, fencing token, and timestamps.
8. Keep the transaction bounded and fail closed on missing tenant membership, stale mission/task state, invalid digests, revoked worker, or inconsistent approval state.

## Fencing, heartbeat, and completion

- Every heartbeat and terminal write must condition on request ID, worker principal, attempt number, fencing token, and unexpired lease.
- Lease expiry does not prove that an external side effect did not occur. Expired RUNNING work must enter reconciliation; it must not be blindly returned to READY.
- A stale worker must be unable to heartbeat, append authoritative outcome, or overwrite a newer attempt after a newer fencing token exists.
- Dispatch intent and the durable outbox row must be committed atomically with the claim before any external side effect.
- The external adapter must use the same persisted idempotency key. If the provider cannot deduplicate or query operation status, ambiguous post-dispatch outcomes must enter manual reconciliation.
- Outcome, evidence provenance, verification request/result, and terminal state must be persisted transactionally or through an append-only evidence/outbox design with explicit idempotency and reconciliation.
- ACK/transport acceptance is not task completion. Semantic verification remains separate and must preserve PARTIAL/NOT_YET_CONNECTED when a verifier is unavailable.

## Required adversarial verification

Before enabling any worker route or dispatch:

- Forged, expired, wrong-issuer, wrong-audience, revoked, replayed, and wrong-environment worker identities are rejected.
- User JWTs, anonymous sessions, service-role credentials, and request-body worker IDs cannot claim work.
- Two or more concurrent workers race for one READY request; exactly one receives the immutable envelope.
- A different tenant, mission, task, capability, action, target, input digest, or envelope digest is denied.
- Approval revocation/cancellation and task/mission state changes race against claim; the database transaction has one deterministic winner.
- Heartbeat/completion with stale owner, expired lease, old attempt, or old fencing token is rejected.
- Worker crash before dispatch is distinguishable from crash after dispatch; no automatic replay occurs while provider outcome is ambiguous.
- Restart, multi-instance concurrency, lease expiry, retry bounds, outbox redelivery, evidence append-only rules, and provider idempotency are tested against PostgreSQL.
- Hosted Supabase JWT claim behavior, function ownership, RLS/FORCE RLS, grants, and key rotation are separately verified before migration.

## Current status and explicit blockers

- No trusted worker identity provider has been selected or wired.
- No worker registry/credential verification or workload-to-capability policy exists.
- No READY-to-RUNNING claim/lease/fencing RPC exists.
- No worker heartbeat, dispatch, completion, or failure route exists.
- No durable execution outcome/evidence transaction is active.
- The execution-request SQL remains a design-only candidate and has not been applied to hosted Supabase.
- Default execution adapters remain NOT_YET_CONNECTED. No worker or production dispatch is activated.

The next implementation decision depends on the actual worker hosting/runtime identity available for HAPPY. Do not invent a trust source or weaken the boundary merely to create a claim endpoint.


## Core workload-identity contract added — 2026-11-22

Added `src/core/mission/trusted-worker-identity.ts` and `src/tests/core/mission/trusted-worker-identity.test.ts`.

The new `TrustedWorkerIdentityProvider` is intentionally an injected boundary, not a concrete hosting-platform integration:

- Credential retrieval is an injected `TrustedWorkerCredentialSource` and must use a hosting-platform-controlled workload identity channel. Request body, query, ordinary user Authorization, and caller-controlled forwarded headers are explicitly prohibited.
- Cryptographic verification is an injected `WorkerCredentialVerifier`; the core module never decodes JWT payloads or treats unverified claims as identity. The verifier contract requires signature/key rotation, issuer, audience, expiry, not-before, and revocation validation.
- The core policy additionally pins issuer, audience, environment, exact workload subject allowlist, capability allowlist, bounded token lifetime, and clock skew.
- Subjects must use the dedicated `workload:` namespace; a human `user:` subject is rejected.
- Missing source/verifier returns `NOT_CONNECTED`; malformed claims, verifier errors, and policy mismatches return `DENIED`. There is no human-session fallback.
- Contract tests cover valid identity, missing provider/credential, verifier failure, wrong issuer/audience/environment, human/unapproved subjects, expired/not-yet-valid/future-issued credentials, excessive lifetime, missing token ID, and invalid/duplicate capabilities. The test is added to `test:security`.

### What this does not do

No concrete Vercel/SPIFFE/OIDC credential source, cryptographic JWT verifier, worker registry, token revocation store, request route, database claim binding, or workload-to-tenant authorization is wired. The new contract is not production worker authentication. A platform integration must be selected and independently verified before any claim/dispatch grants are restored. The scheduler RPCs remain fully revoked for authenticated users and the SQL remains design-only.
