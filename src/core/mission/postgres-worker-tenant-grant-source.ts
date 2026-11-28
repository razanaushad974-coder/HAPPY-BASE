import type { PgQueryable } from "../persistence/adapters/postgres-tenant-adapter";
import type { TenantScope } from "../state/types";
import type {
  AuthorizedNodeWorkerTenant,
  AuthorizedWorkerTenantScopeSource,
} from "./node-worker-scheduler";
import type { WorkerDatabaseSessionProvider } from "./postgres-worker-database-broker";
import type {
  WorkerPrincipalRegistration,
} from "./worker-database-broker";
import type { VerifiedWorkerIdentity } from "./trusted-worker-identity";

interface TenantGrantPageRow {
  organization_id: string;
  workspace_id: string;
  user_id: string;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function requireUuid(value: unknown, field: string): string {
  if (typeof value !== "string" || !UUID.test(value)) {
    throw new TypeError(`Invalid worker tenant grant field: ${field}`);
  }
  return value.toLowerCase();
}

function parseCursor(cursor: string | null): readonly [string | null, string | null, string | null] {
  if (cursor === null) return [null, null, null];
  if (typeof cursor !== "string" || cursor.length > 128) {
    throw new TypeError("Invalid worker tenant grant cursor.");
  }
  const parts = cursor.split("|");
  if (parts.length !== 3) throw new TypeError("Invalid worker tenant grant cursor.");
  return [
    requireUuid(parts[0], "cursor.organizationId"),
    requireUuid(parts[1], "cursor.workspaceId"),
    requireUuid(parts[2], "cursor.userId"),
  ];
}

/**
 * Reads one authorized tenant grant at a time through the dedicated worker
 * PostgreSQL session. The candidate RPC derives the principal from session_user,
 * applies active membership filters, and keyset-paginates without arbitrary
 * tenant enumeration. Each returned scope is still reauthorized by the
 * worker's operation RPC before it can mutate durable state.
 */
export class PostgresWorkerTenantGrantSource implements AuthorizedWorkerTenantScopeSource {
  constructor(private readonly sessions: WorkerDatabaseSessionProvider) {}

  async nextAuthorizedTenant(input: {
    readonly identity: VerifiedWorkerIdentity;
    readonly registration: WorkerPrincipalRegistration;
    readonly cursor: string | null;
    readonly signal?: AbortSignal;
  }): Promise<AuthorizedNodeWorkerTenant | null> {
    const identity = input?.identity;
    const registration = input?.registration;
    if (
      !identity || !registration ||
      typeof identity.principal !== "string" ||
      identity.principal !== registration.subject ||
      identity.issuer !== registration.issuer ||
      identity.audience !== registration.audience ||
      identity.environment !== registration.environment ||
      registration.enabled !== true ||
      registration.revokedAt != null ||
      !registration.capabilities.includes("CONTROL") ||
      !identity.capabilities.includes("CONTROL")
    ) {
      throw new Error("WORKER_TENANT_GRANT_IDENTITY_MISMATCH");
    }

    if (input.signal?.aborted) return null;
    const principalId = requireUuid(registration.principalId, "workerPrincipalId");
    const [afterOrganizationId, afterWorkspaceId, afterUserId] = parseCursor(input.cursor);

    return this.sessions.withTransaction(async (client: PgQueryable) => {
      if (input.signal?.aborted) return null;
      const result = await client.query<TenantGrantPageRow>(
        "select organization_id::text, workspace_id::text, user_id::text from private.happy_worker_list_tenant_grants($1,$2,$3,$4,$5)",
        [principalId, afterOrganizationId, afterWorkspaceId, afterUserId, 1],
      );
      if (!Array.isArray(result.rows) || result.rows.length > 1) {
        throw new Error("WORKER_TENANT_GRANT_PAGE_INVALID");
      }
      if (result.rows.length === 0) return null;

      const row = result.rows[0];
      const organizationId = requireUuid(row.organization_id, "organizationId");
      const workspaceId = requireUuid(row.workspace_id, "workspaceId");
      const userId = requireUuid(row.user_id, "userId");
      const scope: TenantScope & { readonly userId: string } = Object.freeze({
        organizationId,
        workspaceId,
        userId,
      });
      const workerScope = Object.freeze({
        workerPrincipalId: principalId,
        organizationId,
        workspaceId,
        userId,
      });
      const nextCursor = [organizationId, workspaceId, userId].join("|");
      if (nextCursor === input.cursor) {
        throw new Error("WORKER_TENANT_GRANT_CURSOR_DID_NOT_ADVANCE");
      }

      return Object.freeze({
        scope,
        workerScope,
        nextCursor,
      }) satisfies AuthorizedNodeWorkerTenant;
    });
  }
}
