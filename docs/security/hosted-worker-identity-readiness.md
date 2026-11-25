# Hosted worker database identity — read-only gate

**Status: BLOCKED until run against the exact hosted staging pooler endpoint.**
**This check is diagnostic only. It does not apply migrations or change hosted state.**

## Why this is a separate gate

The disposable PostgreSQL CI integration test proves that a fresh TCP connection can authenticate as the dedicated worker LOGIN in that test database. It does **not** prove that the hosted Supabase pooler authenticates the worker as that same database principal.

Do not enable worker scheduler EXECUTE grants or claim hosted worker readiness until this check succeeds through the exact connection route the deployed worker will use.

## Run

1. Confirm the intended staging project and obtain the dedicated worker connection string from the approved secret manager. Do not paste it into chat, logs, shell history, or a committed file.
2. Set `HAPPY_STAGING_WORKER_DATABASE_URL` in a protected terminal/secret-injected environment to the exact hosted pooler connection string used by the worker.
3. Run:

```bash
bash scripts/security/hosted-worker-identity-readonly.sh
```

The script performs only connection metadata reads and catalog privilege checks. It does not issue DDL, DCL, DML, migration commands, or role changes. The connection URI is passed to libpq through the `PGDATABASE` environment variable rather than as a `psql` command-line argument.

## Required evidence

A successful run must show:

- `session_user = happy_worker_dispatch` on a fresh connection through the hosted pooler.
- `current_user = happy_worker_dispatch` before entering any SECURITY DEFINER function.
- The worker role is LOGIN, NOINHERIT, NOSUPERUSER, NOCREATEDB, NOCREATEROLE, NOREPLICATION, and NOBYPASSRLS.
- `happy_worker_registry_owner` and `happy_worker_scheduler_rpc_owner` exist as NOLOGIN, NOINHERIT, NOSUPERUSER, NOBYPASSRLS roles.
- The worker LOGIN is not a member of either SECURITY DEFINER owner role.
- The worker LOGIN has no direct table-level or column-level SELECT, INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, or TRIGGER privileges on tenant records, leases, dispatch outbox, execution requests, worker principal registry, worker tenant grants, or reconciliation evidence. Scoped SECURITY DEFINER owner roles carry the narrowly granted RLS access instead.

Capture the sanitized output with project reference, pooler mode/region, timestamp, commit SHA, and operator identity. Redact hostnames if required by the organization's security policy; never capture the connection string or password.

## Failure handling

Any mismatch is a hard stop. Do not compensate with `SET ROLE`, `SET SESSION AUTHORIZATION`, broad grants, BYPASSRLS, service-role credentials, or a different connection URL. Investigate the actual pooler authentication path and role mapping first.

This diagnostic intentionally does not test a live worker RPC dispatch or enable its EXECUTE grants. Those remain separate approval-gated steps after the hosted principal identity is proven.
