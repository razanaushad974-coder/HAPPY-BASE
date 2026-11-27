# HAPPY Node PostgreSQL worker — staging activation runbook

**Status: documentation/preflight only. No hosted database, role, credential, deployment, or grant has been changed.**

This runbook converts the source-level Node worker into a controlled staging activation. It is intentionally operator-gated: a green CI run is not evidence that Supabase's pooler authenticates as the intended dedicated PostgreSQL LOGIN.

## Current source-level evidence

The following source-level and isolated integration checks passed on the earlier PR #15 head `8a82904ed78d7bd1d061fab38181602d878a6123`, CI run #1866 (30/30 steps; GitHub Actions conclusion: success). The current PR head is `81e57f721fbb8fefe4887e56fd9822317c023c1d`; its validation run #1868 is still in progress, so the latest documentation change is not yet CI-verified:

- TypeScript and the complete security harness suite.
- Async tenant persistence/provider contracts.
- PostgreSQL tenant RLS/CAS integration.
- PostgreSQL worker principal and tenant-grant page integration on disposable PostgreSQL 17.
- Worker scheduler CONTROL/VERIFY RLS probe.
- Async memory, state, evidence, and verification contracts.
- Orchestration tests, ESLint, dependency audit, and production build.

These checks validate source behavior and isolated PostgreSQL fixtures. They do **not** validate a hosted Supabase pooler, hosted identity issuer, staging database, or real external provider dispatch.

CI run #1866 also validated the updated staging-host discovery checkpoint in this runbook. The run is a successful repository validation only; it does not satisfy any hosted activation gate below.

## Activation gates — keep this order

### Gate 0 — establish a staging-only change window

Before touching staging, the project owner/operator must explicitly approve:
- the exact Supabase staging project and database endpoint;
- the exact worker LOGIN role name: `happy_worker_dispatch` for the hosted identity diagnostic and staging activation path described here;
- the exact identity issuer, audience, JWKS URI, subject, owner/project claims, environment, and capabilities;
- the exact SQL candidate commit/hash to review;
- the exact provider adapter and idempotency behavior for a non-production smoke test.

Do not use production project references, production credentials, or production provider accounts for this procedure. Do not paste database URLs, passwords, bearer tokens, private keys, or raw workload credentials into ChatGPT, GitHub issues, logs, or PR comments.

### Gate 1 — provision trusted workload identity outside the application request path

The Node host must supply all of these independently:
1. A credential source that reads a platform-attested workload credential from a host-only identity channel. It must not read request bodies, query parameters, user Authorization headers, or caller-controlled forwarded headers.
2. A cryptographic verifier that checks signature, issuer, audience, expiry, not-before, token lifetime, exact subject, and the required signed workload claims. JWKS refresh and key rotation must fail closed.
3. A separate policy allowlist that pins the exact issuer, audience, staging environment, subject, and only the required capabilities (normally CONTROL and VERIFY for the grant scanner).
4. A secret-manager callback for any verifier bearer token. Never put secret values in public deployment variables or source control.

The repository exports `createNodeTrustedWorkerIdentityResolver()`; this is a composition boundary, not a provisioned identity. A fake verifier in a unit test is not workload attestation.

**Gate 1 evidence:** host operator records the identity provider's configuration/version and successful positive/negative identity tests in the private deployment record. Only non-secret identifiers and pass/fail evidence belong in the PR.

### Gate 2 — verify the actual PostgreSQL LOGIN through the intended pooler

Provision the exact dedicated `happy_worker_dispatch` LOGIN through the approved database administration process. The current SQL candidate does not create this LOGIN; role provisioning is a separate, explicitly approved DBA step. It must be a non-superuser, non-owner, non-BYPASSRLS role with no role-creation/database-creation privileges. Do not use `service_role`, `postgres`, a human login, or a shared application role.

Configure the staging host's secret manager with the dedicated worker connection string. The variable name used by the host example is `HAPPY_WORKER_DATABASE_URL`; a prior staging preflight recorded `HAPPY_STAGING_WORKER_DATABASE_URL` as not set. The host must explicitly map its chosen secret to the pool configuration; do not assume either name is currently configured.

From the **same network path, pooler endpoint, TLS mode, and connection options** that the worker will use, run this read-only diagnostic as the worker connection:

```sql
begin read only;
select
  session_user,
  current_user,
  current_setting('role') as active_role,
  current_database() as database_name,
  current_setting('transaction_read_only') as transaction_read_only;
rollback;
```

Expected result:
- `session_user` is exactly `happy_worker_dispatch`.
- `current_user` is exactly `happy_worker_dispatch` outside SECURITY DEFINER execution.
- `active_role` is `none` (or the platform's documented equivalent showing no role switch).
- This is the intended staging database and the transaction is read-only.

If the pooler reports `service_role`, `postgres`, another role, or an unexpected role switch, **stop**. Do not compensate by changing the expected role in application config. Resolve the pooler authentication mapping first.

Capture only the role names, database/environment label, timestamp, and pass/fail in the private deployment record. Never capture or share the connection string.

### Gate 3 — review and apply the SQL candidate only in staging

Candidate: `supabase/drafts/20261127_worker_tenant_grant_page_rpc_candidate.sql`.

It is a draft, not a migration. Before applying:
- review the exact file at the approved commit;
- verify the existing `happy_worker_registry_owner` role and the helper functions' ownership/privileges;
- confirm the function uses `session_user`-derived principal identity, exact selector matching, CONTROL capability, active canonical memberships, row locks, and bounded keyset pagination;
- confirm the candidate revokes direct EXECUTE from PUBLIC, anon, authenticated, service_role, and any existing `happy_worker_*` roles;
- confirm the candidate contains **no** EXECUTE grant to a worker;
- confirm the owner role is NOLOGIN and receives only the required column-level read/update privileges.

Apply only after separate explicit staging approval, using the team's controlled migration/DBA procedure. Do not add this draft to the production migration chain merely to make CI green.

After application, inspect the function owner and ACL before granting anything:

```sql
select
  p.oid::regprocedure as function_signature,
  owner_role.rolname as function_owner,
  owner_role.rolcanlogin as owner_can_login,
  owner_role.rolsuper as owner_is_superuser,
  acl.grantee_role,
  acl.privilege_type,
  acl.is_grantable
from pg_catalog.pg_proc p
join pg_catalog.pg_namespace n on n.oid = p.pronamespace
join pg_catalog.pg_roles owner_role on owner_role.oid = p.proowner
left join lateral (
  select
    case when x.grantee = 0 then 'PUBLIC' else grantee_role.rolname end as grantee_role,
    x.privilege_type,
    x.is_grantable
  from pg_catalog.aclexplode(
    coalesce(p.proacl, pg_catalog.acldefault('f', p.proowner))
  ) x
  left join pg_catalog.pg_roles grantee_role on grantee_role.oid = x.grantee
) acl on true
where n.nspname = 'private'
  and p.proname = 'happy_worker_list_tenant_grants';
```

Expected before the worker grant:
- owner is the approved NOLOGIN, non-superuser registry owner;
- there is no EXECUTE for PUBLIC, anon, authenticated, service_role, or any worker LOGIN;
- no unexpected owner or grantor exists.

Only after Gate 2 and this ACL review pass may the DBA, under explicit approval, grant EXECUTE to the **one exact verified staging LOGIN `happy_worker_dispatch`**. Never grant to a wildcard role, PUBLIC, API roles, or all `happy_worker_*` roles. Re-run the ACL query immediately after the grant and record the exact grantee.

### Gate 4 — validate principal registration and grant-page behavior

Use only staging test fixtures and the exact verified worker LOGIN. Confirm:
- the DB registry row binds the LOGIN, issuer, subject, audience, environment, and capabilities;
- the principal is enabled and not revoked;
- the tenant grant is enabled and limited to the intended test organization/workspace/user;
- organization, workspace, organization membership, and workspace membership are active;
- the grant page returns only that authorized scope and obeys the page-size/cursor contract;
- disabling/revoking the grant or membership immediately removes it from subsequent scans;
- the worker cannot directly SELECT registry or tenant-grant tables;
- the worker cannot access another tenant by changing a supplied selector or cursor.

Do not seed or mutate real customer tenant grants for this test. Use a designated staging-only fixture and remove it through the approved cleanup process after evidence capture.

### Gate 5 — first dispatch smoke test (staging only)

Before running the host:
- confirm the host uses the same pool instance for broker operations and shutdown;
- confirm concurrency is one and `maxTenants` is between 1 and 20;
- confirm provider calls are idempotency-key gated and the provider is a staging/test adapter;
- confirm leases, heartbeats, fencing, durable outcomes, and reconciliation evidence are enabled;
- confirm SIGTERM/SIGINT aborts between operations, waits for an in-flight operation to settle, removes listeners, and closes that exact pool;
- confirm an ambiguous provider outcome is reconciled, not blindly retried.

Start one bounded invocation only. Capture operation ID, tenant fixture ID, idempotency key hash (not secret material), result status, fencing/lease evidence, and reconciliation result. Do not run a continuous scheduler until separate concurrency, restart, crash-recovery, and operational alerting plans have been reviewed.

## Stop conditions

Stop immediately and do not grant or dispatch if any of these occur:
- identity verification returns DENIED or NOT_CONNECTED;
- `session_user` or `current_user` differs from the exact expected LOGIN;
- registry subject/issuer/audience/environment/capabilities mismatch;
- SQL owner or ACL differs from the reviewed least-privilege expectation;
- tenant scope, membership, cursor, or principal binding is ambiguous;
- provider idempotency or durable outcome evidence is unavailable;
- a test would touch production data or a production provider.

## Evidence and status reporting

Record each gate as PASS/FAIL/BLOCKED with timestamp, commit SHA, staging project label, and operator. Keep secret values out of the evidence. A successful CI run is recorded as **source-level/isolated integration PASS** only. Mark hosted activation complete only after Gates 0–5 have independently passed in staging.

## Host discovery checkpoint — 2026-11-27

Read-only inventory of the connected Vercel team found four HAPPY application projects. No dedicated worker service or active persistent worker sandbox was identified. The only worker-named sandbox, `happy-worker-deps-check`, is stopped, non-persistent, and its command history shows dependency inspection/installation only; it is not a running worker host. The `happy-base` project has only branch-scoped Supabase preview configuration and no worker database URL or trusted-identity configuration in its visible environment-variable metadata. This is evidence about the inspected Vercel team scope only; it does not rule out a separately managed host outside that scope.

No sandbox was resumed or created, no environment-variable values were decrypted, and no host credentials were read or changed.

## Current outstanding external dependencies

- Staging worker database URL/secret is not confirmed provisioned.
- The exact `happy_worker_dispatch` LOGIN has not been provisioned in the blank staging project; the hosted pooler `session_user/current_user` diagnostic has not been run.
- Trusted workload credential source, issuer/JWKS, and exact staging subject are not provisioned by this repository change.
- Tenant-grant RPC candidate has not been deployed to hosted staging; hosted EXECUTE remains withheld.
- No real Node worker dispatch, continuous poller, concurrency controller, or crash-recovery/restart supervisor has been deployed.
- No production action is authorized by this runbook.
