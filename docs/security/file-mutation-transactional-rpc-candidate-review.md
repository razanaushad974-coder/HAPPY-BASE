# Transactional FILE grant RPC candidate — review notes

**Status:** executable design candidate committed on PR #8; not an approved production migration. It has not been applied to any Supabase project.

## Chosen database caller model

The candidate chooses a **user-scoped Supabase JWT** for the consume call:

- The public RPC accepts no requester, executor, or approver user-ID parameter.
- The function derives executor only from auth.uid().
- The durable private.execution_requests row supplies requester, immutable executor, task, mission, and tenant scope.
- The grant row supplies approver; the function locks and revalidates that approver's current organization membership and explicit role.
- The RPC is executable by authenticated only; anon, PUBLIC, and service_role are explicitly revoked.
- The function is SECURITY DEFINER with fixed search_path = pg_catalog; every application table/function reference is schema-qualified. It contains no dynamic SQL.

This means the production consume client must be a server-side, user-scoped Supabase client carrying the same verified executor JWT. A service-role client must not call this RPC, because auth.uid() would not establish the end-user executor. Do not add an executor-ID argument to make service-role calls work.

## Candidate files

- supabase/drafts/20261119_file_mutation_atomic_consume_candidate.sql
  - Full proposed private tenant, membership, execution request, grant, and audit tables.
  - One public transactional RPC.
  - Row lock order: organization → workspace → durable request → organization membership rows sorted by user UUID → executor workspace membership → grant.
  - Role policy is explicit: FOUNDER grants require current organization role FOUNDER; ADMIN grants accept only FOUNDER or ADMIN. Workspace roles do not grant approval authority.
  - Consumption timestamp comes from clock_timestamp() once, and expiry is checked against that same timestamp and repeated in the UPDATE predicate.
  - Exact binding uses IS DISTINCT FROM so NULL caller values cannot turn a failed comparison into SQL NULL that accidentally passes an IF.
  - One audit row is inserted in the same transaction after the grant transition.
  - Audit event privileges are append-only for service_role (SELECT/INSERT; no UPDATE/DELETE).

- scripts/security/postgres-file-grant-transaction-integration.sh
  - Runs the candidate against a disposable PostgreSQL database.
  - Stubs only auth.users and auth.uid() to emulate the Supabase database contract; it does not test the external JWT verifier or a live Supabase deployment.
  - Tests distinct requester/approver/executor, JWT executor mismatch, exact digest binding, expiry, replay, revoked/demoted approver, revoked executor, one audit event, concurrent single-winner consumption, revocation-first blocking, consume-first serialization, and anon EXECUTE denial.

- .github/workflows/postgres-security-integration.yml
  - Runs the original fixture and this candidate-RPC integration script in an isolated PostgreSQL 17 service container.

## Important limitations / gates

1. This schema is a self-contained candidate, not reconciled with the final HAPPY tenant model. It proposes UUID tenant/workspace IDs and a particular table/column naming contract. The connected Supabase project was previously inspected read-only and had no HAPPY application tables or migrations. Do not apply this file to that project.
2. The local PostgreSQL harness stubs Supabase auth.uid() claim context. It tests database transaction behavior and function ACLs, not the JWT signature validation performed by Supabase Auth/PostgREST.
3. The existing SupabaseNamedExecutorGrantStore still performs a conditional REST UPDATE and is not switched to this RPC. A production adapter must use a user-scoped client for the RPC and must prove that its JWT subject matches the current server session. Do not mix a service-role grant lookup with an assumed service-role consume identity.
4. Grant creation, approval, revocation, cancellation, and complete audit workflow are not implemented by this candidate. Membership revocation is expected to update the same locked membership row; all future tenant/membership writers must preserve the documented lock discipline.
5. A complete production migration requires explicit review of the schema, trigger/immutability rules, grants, RLS, role mapping, indexes, request lifecycle, RPC client, and migration-backed adapter tests.
6. FILE READ and FILE mutations remain default-deny. The authorizer is not wired into production composition.

## Safety boundary

No SQL has been executed against the connected Supabase project. No migration, schema, data, RLS policy, or production configuration was changed. No merge, production deployment, or main change was performed.