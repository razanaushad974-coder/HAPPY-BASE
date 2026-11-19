# FILE grant identity model reconciliation

**Status:** blocking design note; no SQL or migration is applied.

## Conflict found

The original `file-mutation-grant-store-schema-proposal.md` contains an earlier identity section that says the authenticated execution actor must be the same user as the grant approver. The newer `NamedExecutorFileMutationAuthorizer` explicitly models three principals: requester from a durable execution request, executor from the current verified server session, and approver from the persisted approval grant with independent membership/role revalidation.

These are incompatible authorization models. The database schema, RPC signature, audit model, and tests must follow one explicit decision. Do not silently preserve the older same-actor restriction while claiming the newer named-executor flow is implemented.

## Candidate model for PR #8

Use the distinct-principal model already implemented by the named-executor verifier:
- requester: immutable `requester_user_id` from the durable server-owned execution request;
- executor: derived from a verified authenticated server session; never accepted as an untrusted RPC argument;
- approver: immutable `approver_user_id` from the persisted approval decision/grant and independently revalidated against current membership and role;
- approver must not equal requester (self-approval prohibited); approver may differ from executor; requester may equal executor if policy permits.

Do not accept an arbitrary executor ID from a service-role caller. The database caller identity design must be solved before the RPC is implemented. Preferred route is a user-scoped Supabase client whose verified JWT makes `auth.uid()` the executor. If the actual runtime must use service-role, a separately reviewed cryptographically/non-forgeably bound identity assertion is required; a plain parameter is not sufficient.

## Schema and RPC implications

The grant must persist requester, approver, and executor IDs separately, plus exact tenant/request/task/mission, FILE target, operation, source/destination, digest, required role, status, expiry, decision timestamp and consumption timestamp.

The single transaction must lock and validate, in a deterministic global order: active organization, active workspace belonging to that organization, durable execution request, executor memberships, approver organization membership and current mapped role, and finally the exact grant. It must validate all immutable bindings and expiry using the database clock, transition one APPROVED grant to CONSUMED, and append one audit event. Membership/role revoke or downgrade must lock/update the same membership row so revocation and consumption serialize.

Workspace membership role must not independently confer organization-level FOUNDER/ADMIN approval authority unless a separately reviewed policy explicitly says so. Role mapping must be an explicit database policy, not lexical role ranking.

## Required tests before wiring

1. Requester, approver, executor are distinct and valid: one successful consume.
2. Requester equals approver: denied by database constraint/function.
3. Approver differs from executor: accepted only when current approver membership/role is valid.
4. Executor identity cannot be spoofed through RPC arguments.
5. Approver revoked/demoted before consume commits: denied.
6. Consume commits before later revocation: valid at its serialization point.
7. Tenant, request, task, mission, target, operation, path, destination, digest, expiry, replay and cross-tenant substitutions all deny.
8. Two consumers race: one consume and one audit event only.
9. Tests execute the real migration-created tables and RPC through the same client/identity path as the adapter.

## Explicit hold points

- Do not generate or apply a migration until canonical organization/workspace schema and ID types are confirmed.
- Do not choose a SECURITY DEFINER/service-role RPC until executor identity is independently authenticated at the database boundary.
- Do not wire the authorizer into production FILE execution.
- Keep FILE READ and mutations default-deny.
- No production Supabase writes, migrations, deployment, merge, or changes to `main`.