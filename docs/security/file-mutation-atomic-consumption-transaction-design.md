# FILE approval atomic-consumption transaction design

**Status:** implementation contract / design only. No migration or function is included here, and nothing has been applied to Supabase.

## 1. Why this boundary is required

The current TypeScript verifier performs these operations in sequence:
1. Load the durable execution request and verified executor identity.
2. Load an APPROVED grant with exact operation binding.
3. Re-read the approver's active membership.
4. Check the approver's current FOUNDER/ADMIN policy role.
5. Conditionally UPDATE the grant from APPROVED to CONSUMED.

The final UPDATE is atomic for the grant row, but steps 3–4 are outside that UPDATE's transaction. Membership or role revocation can commit after the role check and before grant consumption. A successful conditional grant UPDATE therefore does not prove that the approver remained authorized at the consumption serialization point.

The current PostgreSQL CI script is a disposable fixture. It proves private-schema client denial, a tenant-scoped lookup predicate, state visibility for revoked/demoted membership fixtures, requester self-approval CHECK behavior, one-winner conditional grant consumption, and one-winner REVOKED-vs-CONSUMED state transition. It does not yet prove membership/role-revocation-vs-consumption safety, nor does it execute the production Supabase adapter against a migration-backed schema.

## 2. Required transaction contract

The production operation must be a single database transaction with a single externally visible result: consume_file_mutation_approval_grant(binding) -> consumed | denied.

It must validate and lock, in a documented deterministic order:
1. Canonical organization and workspace rows; both ACTIVE and correctly related.
2. Durable execution request; immutable tenant, request/task/mission, requester and named executor must match.
3. Executor organization and workspace memberships; both ACTIVE in the exact tenant.
4. Persisted approver organization membership; ACTIVE and current role explicitly maps to required FOUNDER/ADMIN. Workspace roles must not confer organization approval authority.
5. Grant row; APPROVED, unexpired by database clock, unconsumed, unrevoked, and exact match for grant id, tenant, request/task/mission, requester, executor, approver, FILE target, operation, source/destination path and canonical digest.

Only after all checks pass may the transaction transition exactly one grant to CONSUMED, set the database consumption timestamp, and append one audit event. Any missing row, inactive status, role mismatch, expiry, binding mismatch, SQL error, or unexpected affected-row count must deny without partial state.

## 3. Revocation serialization

Membership and role changes must participate in the same locking protocol. The revocation transaction must lock/update the same membership row that consumption locks for validation. A role downgrade is a membership-row update and must serialize identically.

Required invariant:
- If revocation/demotion commits first, consumption denies.
- If consumption commits first, it was authorized at its serialization point; subsequent revocation does not retroactively undo that completed operation.
- No outcome may allow consumption after revocation commits using a pre-revocation role snapshot.

Use row locks (SELECT ... FOR UPDATE) or an equivalent serializable protocol with explicit retry handling. Define one global lock order across organization, workspace, execution request, membership rows, and grant. Do not rely on application-side prechecks or separate REST calls.

## 4. Trusted caller boundary remains open

The provider derives executor identity from a verified server session. The database function must preserve that property.

- Preferred with a user-scoped Supabase client: derive executor from auth.uid(); caller cannot supply or override the executor principal. Only a verified user JWT is accepted.
- With a server-only service-role client: auth.uid() is normally not an authenticated end-user identity. Do not pretend it is. A separately reviewed, non-forgeable server-to-database identity assertion is required, or use a verified user-scoped JWT for this operation. A plain executor_user_id argument from a service-role caller is not proof.

The RPC must not be executable by PUBLIC, anon, or ordinary authenticated clients unless the chosen model explicitly requires it and the function independently validates caller identity. SECURITY DEFINER requires fixed safe search_path, fully qualified names, no caller-controlled dynamic SQL, and narrow EXECUTE grants.

## 5. Adapter changes required

SupabaseNamedExecutorGrantStore.consumeApprovedGrant currently sends a conditional table UPDATE. Replace it with one call to the reviewed transactional RPC (or equivalent transaction boundary). The RPC returns a narrow success/denial result; errors fail closed.

The TypeScript approver membership provider can remain useful for early denial and diagnostics, but is not the security boundary. The database transaction must revalidate approver role and executor membership.

Do not wire the authorizer into FILE execution composition until the schema/UUID contract, caller identity model, migration/function, adapter, real PostgreSQL tests, approval workflow, and server-only composition are reviewed end-to-end.

## 6. Disposable-Postgres acceptance tests

1. Valid exact binding consumes once and writes exactly one audit event.
2. Wrong executor, requester, approver, tenant, request/task/mission, FILE target, operation, path, destination, digest, expired/replayed/revoked grant denies.
3. Missing, suspended, or revoked organization/workspace/executor/approver membership denies.
4. Approver role downgrade from OWNER/ADMIN to a non-approving role denies.
5. Concurrent consumers produce exactly one success and one audit event.
6. Revoke-vs-consume and role-downgrade-vs-consume races obey serialization in both forced commit orders.
7. Organization/workspace suspension-vs-consume obeys the same invariant.
8. Caller-role tests prove unauthorized roles cannot invoke privileged consumption.
9. Tests run against the actual migration-created schema and same RPC invocation path as the production adapter, not a hand-built approximation.

## 7. Explicit non-actions

This document does not create/apply SQL, migrations, tables, functions, grants, RLS policies, Supabase data, or production configuration. It does not activate FILE READ or FILE mutations. PR merge and deployment remain separate approval gates.