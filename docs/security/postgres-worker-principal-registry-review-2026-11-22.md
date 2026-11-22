# PostgreSQL worker principal and tenant-scope registry — 2026-11-22

## Added design candidate

`supabase/drafts/20261122_worker_principal_registry_candidate.sql` defines two private tables:

- `private.happy_worker_principal_registry`: maps a dedicated PostgreSQL LOGIN role to an operator-managed worker principal, issuer, subject, audience, environment, capability allowlist, enabled/activation state, and revocation state.
- `private.happy_worker_tenant_grants`: maps that worker principal to explicitly allowed organization/workspace/user scopes and a narrower capability allowlist.

Both tables have direct privileges revoked from `PUBLIC`, `anon`, `authenticated`, and `service_role`. No worker role is granted table access. No LOGIN role is created, no secret is provisioned, and no RPC EXECUTE grant is issued by this draft.

## Database-derived identity

`private.happy_require_worker_principal(capability)` derives the login name from PostgreSQL `session_user`, then checks the actual role catalog and the live registry row. It rejects roles that cannot login or have superuser, role-creation, database-creation, replication, or RLS-bypass privileges. It checks enabled/activated/revoked state and the required capability. It does not accept a caller-supplied worker ID or role name.

## Tenant scope

`private.happy_require_worker_tenant_scope(worker, organization, workspace, user, capability)` first re-derives the worker from `session_user`; the supplied worker ID is only a comparison value. It then locks and rechecks the current worker registry row, worker tenant grant, organization, workspace, organization membership, and workspace membership. A user ID is a selector only and must match the worker's active tenant grant and active canonical memberships. Revoked memberships or disabled grants fail closed.

The helper's future SECURITY DEFINER owner is a dedicated NOLOGIN, non-BYPASSRLS role. The draft enables RLS and adds owner-only SELECT policies for the registry and canonical tenant tables. The owner receives SELECT plus narrowly scoped column UPDATE privileges required by PostgreSQL for `SELECT ... FOR SHARE` row locks; it receives no general table-wide UPDATE. No runtime login receives those table privileges. The role must be provisioned before this draft is applied, and the exact owner/grant model must be reviewed against the target Supabase project.

## PostgreSQL integration coverage

`scripts/security/postgres-worker-principal-registry-integration.sh` creates disposable local PostgreSQL roles and schema fixtures, then verifies:

- A dedicated LOGIN role resolves only its registered worker identity.
- CONTROL and VERIFY allowlisted capabilities resolve; unregistered API capability is denied.
- Duplicate/unknown capability registration is rejected.
- The worker cannot read either registry table directly.
- Human `authenticated` and `service_role` cannot read the registry or execute the private identity helper.
- A worker cannot select an ungranted user scope.
- Active worker scope is accepted only while organization/workspace and both memberships are active.
- Revoked workspace membership and revoked worker registration are denied.

This harness uses isolated PostgreSQL roles and is not proof of hosted Supabase role/pooler behavior.

## Explicitly incomplete

- The registry row's issuer/subject/audience/environment must be provisioned by a trusted operator after independent cryptographic workload-token verification. The database login mapping alone does not prove an OIDC token.
- No actual Vercel credential source, dedicated worker deployment, login credential rotation, or revocation automation exists yet.
- No worker claim/heartbeat/enqueue/outbox-claim/outcome/reconciliation SQL RPCs are implemented against this registry.
- The existing scheduler draft still uses `auth.uid()` for human-owned task and approval scope. Worker-specific functions must derive `user_id` from the worker tenant grant and re-check persisted founder approval, task/mission binding, current lease/fencing token, and idempotency inside the same transaction.
- No typed `WorkerDatabaseBroker` adapter is connected to these SQL functions.
- No migration has been applied; no hosted Supabase resource, role, credential, grant, or deployment has been changed.

Status: database identity registry and tenant-scope resolution are draft-only; production worker authorization remains `NOT_YET_CONNECTED`.
