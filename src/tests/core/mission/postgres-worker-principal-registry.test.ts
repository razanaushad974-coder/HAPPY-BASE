import { PostgresWorkerPrincipalRegistry } from "../../../core/mission/postgres-worker-principal-registry";
import type { WorkerDatabaseSessionProvider } from "../../../core/mission/postgres-worker-database-broker";
import type { PgQueryable, PgQueryResult } from "../../../core/persistence/adapters/postgres-tenant-adapter";

const row = {
  worker_principal_id: "principal-123",
  issuer: "https://oidc.vercel.com/team",
  subject: "owner:team:project:happy-worker:environment:production",
  audience: "https://happy.example/worker",
  environment: "production",
  capabilities: ["CONTROL", "VERIFY"],
};

class FakeSessions implements WorkerDatabaseSessionProvider {
  readonly calls: Array<{ sql: string; values?: readonly unknown[] }> = [];
  constructor(
    private readonly rows: unknown[] = [row],
    private readonly shouldThrow = false,
  ) {}

  async withTransaction<T>(operation: (client: PgQueryable) => Promise<T>): Promise<T> {
    const client = {
      query: async <Row = Record<string, unknown>>(sql: string, values?: readonly unknown[]): Promise<PgQueryResult<Row>> => {
        this.calls.push({ sql, values });
        if (this.shouldThrow) throw new Error("registry database unavailable");
        return { rows: this.rows as Row[], rowCount: this.rows.length };
      },
    } as PgQueryable;
    return operation(client);
  }
}

async function main(): Promise<void> {
  const sessions = new FakeSessions();
  const registry = new PostgresWorkerPrincipalRegistry(sessions);
  const registration = await registry.findByIssuerSubjectEnvironment({
    issuer: row.issuer,
    subject: row.subject,
    environment: row.environment,
  });
  if (
    !registration ||
    registration.principalId !== row.worker_principal_id ||
    registration.enabled !== true ||
    registration.revokedAt !== null ||
    registration.audience !== row.audience ||
    registration.capabilities.join(",") !== "CONTROL,VERIFY"
  ) throw new Error("Active session_user worker registration was not mapped.");

  const call = sessions.calls[0];
  if (
    sessions.calls.length !== 1 ||
    call.sql !== "select * from private.happy_require_worker_principal($1)" ||
    call.values?.[0] !== "CONTROL"
  ) throw new Error("Registry adapter must call only the session_user-derived private identity helper.");

  const mismatched = new PostgresWorkerPrincipalRegistry(new FakeSessions());
  if (await mismatched.findByIssuerSubjectEnvironment({
    issuer: "https://attacker.example",
    subject: row.subject,
    environment: row.environment,
  }) !== null) throw new Error("Issuer mismatch was accepted.");

  if (await mismatched.findByIssuerSubjectEnvironment({
    issuer: row.issuer,
    subject: row.subject,
    environment: "preview",
  }) !== null) throw new Error("Environment mismatch was accepted.");

  if (await new PostgresWorkerPrincipalRegistry(new FakeSessions([])).findByIssuerSubjectEnvironment({
    issuer: row.issuer,
    subject: row.subject,
    environment: row.environment,
  }) !== null) throw new Error("Missing principal was accepted.");

  if (await new PostgresWorkerPrincipalRegistry(new FakeSessions([{
    ...row,
    capabilities: ["CONTROL", "CONTROL"],
  }])).findByIssuerSubjectEnvironment({
    issuer: row.issuer,
    subject: row.subject,
    environment: row.environment,
  }) !== null) throw new Error("Duplicate capabilities in a registry row were accepted.");

  if (await new PostgresWorkerPrincipalRegistry(new FakeSessions([], true)).findByIssuerSubjectEnvironment({
    issuer: row.issuer,
    subject: row.subject,
    environment: row.environment,
  }) !== null) throw new Error("Registry database failure did not fail closed.");

  if (await registry.findByIssuerSubjectEnvironment({
    issuer: "",
    subject: row.subject,
    environment: row.environment,
  }) !== null) throw new Error("Malformed registry lookup input was accepted.");

  console.log("PostgreSQL worker principal registry adapter: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
