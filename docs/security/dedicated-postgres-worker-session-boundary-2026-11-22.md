# Dedicated PostgreSQL worker session boundary — 2026-11-22

## Change

Added `src/core/mission/postgres-worker-database-session.ts` and its standalone regression test.

The provider:
- Acquires a PostgreSQL connection from an injected pool.
- Starts one transaction and reads `session_user` and `current_user` from PostgreSQL itself.
- Requires both values to equal the server-configured dedicated login role, with a restricted role-name format.
- Rejects a connection authenticated as `authenticated`, `service_role`, or any role other than the configured worker login.
- Rejects a connection where `current_user` differs from `session_user`, preventing a pre-switched role from being accepted.
- Applies bounded statement and idle-transaction timeouts.
- Rolls back on authorization, query, or callback failure and always releases the connection.
- Does not execute `SET ROLE`, set `auth.uid()`, set JWT claim GUCs, or accept a worker principal from request data.

## Security boundary

This is a database-login verification primitive only. It does not:
- Provision or create a PostgreSQL role or credential.
- Implement the worker registry or revocation.
- Implement the worker SQL RPCs / actual `WorkerDatabaseBroker`.
- Prove tenant membership, founder approval, task binding, lease fencing, or provider idempotency.
- Verify hosted Supabase connection-pooler preservation of `session_user`.
- Enable any grants, apply migrations, connect a hosted database, or deploy a worker.

The callback receives a transaction-scoped query interface for use by trusted server-side typed adapters only. Do not expose it as a general-purpose SQL endpoint. The future broker must call only the reviewed worker-specific database functions, which must independently derive the worker principal from the authenticated DB session and re-check tenant/approval state transactionally.

## Verification

A fake-pool contract test covers:
- Dedicated worker role configuration requirement.
- Matching `session_user` and `current_user`.
- Denial before callback execution when the login principal mismatches.
- Denial when the active role differs from the login role.
- Absence of user-auth impersonation setup.
- Rollback and connection release.

The test is added to `test:security`. CI for the commit that adds this contract must complete before it is considered verified. A fake pool does not establish live PostgreSQL or hosted Supabase compatibility.

## Status

- Code-level dedicated DB session boundary: implemented.
- Local/fake-pool contract: included in CI; pending latest workflow result.
- Actual dedicated DB role/credential: `NOT_YET_CONNECTED`.
- Worker registry and DB principal mapping: `NOT_IMPLEMENTED`.
- Typed PostgreSQL worker RPCs / real broker: `NOT_IMPLEMENTED`.
- Hosted Supabase principal preservation: `NOT_VERIFIED`.
- Worker grants: remain revoked.
