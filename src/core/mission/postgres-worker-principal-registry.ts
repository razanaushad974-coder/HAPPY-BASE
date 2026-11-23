import type { PgQueryable } from "../persistence/adapters/postgres-tenant-adapter";
import type { WorkerDatabaseSessionProvider } from "./postgres-worker-database-broker";
import type { WorkerPrincipalRegistration, WorkerPrincipalRegistry } from "./worker-database-broker";

interface CurrentWorkerPrincipalRow {
  worker_principal_id: string;
  issuer: string;
  subject: string;
  audience: string;
  environment: string;
  capabilities: string[];
}

/**
 * Reads only the identity mapped to PostgreSQL session_user.
 *
 * The SECURITY DEFINER helper derives the LOGIN role from session_user and
 * returns only its active registry row. The function must be EXECUTE-granted
 * exclusively to the dedicated happy_worker_* LOGIN roles after provisioning;
 * never grant it to PUBLIC, anon, authenticated, or service_role.
 */
export class PostgresWorkerPrincipalRegistry implements WorkerPrincipalRegistry {
  constructor(private readonly sessions: WorkerDatabaseSessionProvider) {}

  async findByIssuerSubjectEnvironment(input: {
    issuer: string;
    subject: string;
    environment: string;
  }): Promise<WorkerPrincipalRegistration | null> {
    if (
      typeof input?.issuer !== "string" || !input.issuer.trim() ||
      typeof input.subject !== "string" || !input.subject.trim() ||
      typeof input.environment !== "string" || !input.environment.trim()
    ) return null;

    try {
      return await this.sessions.withTransaction(async (client: PgQueryable) => {
        const result = await client.query<CurrentWorkerPrincipalRow>(
          "select * from private.happy_require_worker_principal($1)",
          ["CONTROL"],
        );
        if (result.rows.length !== 1) return null;
        const row = result.rows[0];
        if (
          !row ||
          typeof row.worker_principal_id !== "string" || !row.worker_principal_id.trim() ||
          typeof row.issuer !== "string" ||
          typeof row.subject !== "string" ||
          typeof row.audience !== "string" ||
          typeof row.environment !== "string" ||
          !Array.isArray(row.capabilities) ||
          row.capabilities.length === 0 ||
          row.capabilities.some((capability) => typeof capability !== "string") ||
          new Set(row.capabilities).size !== row.capabilities.length ||
          row.issuer !== input.issuer ||
          row.subject !== input.subject ||
          row.environment !== input.environment
        ) return null;

        return Object.freeze({
          principalId: row.worker_principal_id,
          issuer: row.issuer,
          subject: row.subject,
          audience: row.audience,
          environment: row.environment,
          enabled: true,
          capabilities: Object.freeze([...row.capabilities]) as WorkerPrincipalRegistration["capabilities"],
          revokedAt: null,
        });
      });
    } catch {
      // DB outage, revoked principal, missing EXECUTE grant, and malformed
      // registry data all fail closed. No in-memory or service-role fallback.
      return null;
    }
  }
}
