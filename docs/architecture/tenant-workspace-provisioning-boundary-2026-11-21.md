# HAPPY tenant workspace provisioning boundary

**Date:** 2026-11-21  
**Branch:** `platform/full-happy-audit-and-integration`  
**Status:** Contract implemented; persistent-volume provider and runtime wiring are not connected.

## Decision

HAPPY must not derive a tenant workspace from `process.cwd()`, a request-supplied path, a user ID in request JSON, or a shared application directory. The current `WorkspaceCodeExecutor` requires an explicit root, but that alone does not establish tenant ownership, persistence, or safe multi-instance behavior.

The `TenantWorkspaceProvisioner` contract accepts only a `CanonicalTenantContext`, which is expected to come from verified request identity plus exact active organization/workspace membership. Its executor now implements the asynchronous-capable `WorkspaceFileExecutor` operation interface. This permits either a local executor over a genuinely durable isolated volume or a remote persistent worker; it does not assume that a host path is available. The provider result is accepted only when its binding exactly matches the verified user, organization, and workspace and it declares an isolated persistent volume. Any incomplete context, provider error, disconnected provider, malformed executor, or scope mismatch returns `NOT_YET_CONNECTED`.

## Filesystem executor boundary

The current path validator rejects traversal, symlink components (including dangling final symlinks), and regular files with multiple hard links. Regression tests exercise symlink and hard-link escape attempts. This is defense in depth, not a substitute for an OS-enforced sandbox: path validation followed by ordinary Node filesystem operations can still have time-of-check/time-of-use races if an untrusted process can mutate the mounted tree concurrently. A production provider must prevent untrusted concurrent mutation of directory entries or use descriptor-relative/no-follow filesystem operations in an isolated worker. Do not treat the current executor as safe for adversarial multi-process access to a shared mount.

## Provider requirements before implementation

A production provider must prove all of the following before returning `PROVISIONED`:

1. Storage is durable across process restarts and application instances; ephemeral serverless filesystem storage is not sufficient.
2. Every tenant has an isolated volume or equivalent OS-enforced boundary. A path prefix alone is not tenant isolation.
3. Volume ownership and permissions are server-controlled; request payloads cannot select the root, mount, bucket, or storage key namespace.
4. Provisioning is idempotent and concurrency-safe for the exact user/organization/workspace binding.
5. Quotas, file-count and size limits, lifecycle/deletion policy, backups, restore, and audit events are defined.
6. Symlink, hard-link, mount, traversal, and race protections are enforced at the storage/OS boundary, not only by string path validation.
7. The executor cannot reach application source, secrets, other tenants' mounts, or host control sockets.
8. The provider is tested under concurrent provisioning, restart, worker handoff, revoked membership, and cross-tenant access attempts.

## Current runtime state

- `NotConnectedTenantWorkspaceProvisioner` is the safe default and always returns `NOT_YET_CONNECTED`.
- `resolveTenantWorkspaceExecutor` validates canonical context and exact provider binding before returning a `WorkspaceFileExecutor`.
- `FileExecutionAdapter` awaits the executor operation, so a future remote worker can return asynchronous results without changing the authorization boundary.
- The contract is not wired into `ExecutionEngine` or an API route.
- FILE execution therefore remains unavailable unless a separately trusted runtime explicitly injects a tenant-bound executor and its read/mutation authorizers.
- No local or remote provider is connected or presented as production-ready; no database migration, storage provisioning, deployment, or production write was performed.

## Verification

`src/tests/core/execution/tenant-workspace-provisioner.test.ts` covers disconnected storage, invalid canonical context, cross-user binding rejection, exact binding acceptance, and provider failure. CI must run the test before this contract is treated as validated.
