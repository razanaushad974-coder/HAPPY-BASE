import {
  PostgresWorkerDatabaseSessionProvider,
  WorkerDatabaseSessionError,
} from "../../../core/mission/postgres-worker-database-session";
import type {
  PgClientLike,
  PgPoolLike,
  PgQueryResult,
} from "../../../core/persistence/adapters/postgres-tenant-adapter";

class FakeWorkerClient implements PgClientLike {
  readonly statements: Array<{ sql: string; values?: readonly unknown[] }> = [];
  released = false;

  constructor(
    private readonly sessionUser: string,
    private readonly currentUser: string,
  ) {}

  async query<Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<Row>> {
    this.statements.push({ sql, values });
    if (sql.includes("session_user::text")) {
      return {
        rows: [{
          session_user: this.sessionUser,
          current_user: this.currentUser,
        } as unknown as Row],
        rowCount: 1,
      };
    }
    return { rows: [], rowCount: 0 };
  }

  release(): void {
    this.released = true;
  }
}

class FakeWorkerPool implements PgPoolLike {
  readonly clients: FakeWorkerClient[] = [];

  constructor(
    private readonly sessionUser = "happy_worker_dispatch",
    private readonly currentUser = "happy_worker_dispatch",
  ) {}

  async connect(): Promise<PgClientLike> {
    const client = new FakeWorkerClient(this.sessionUser, this.currentUser);
    this.clients.push(client);
    return client;
  }
}

async function main(): Promise<void> {
  let invalidRoleDenied = false;
  try {
    new PostgresWorkerDatabaseSessionProvider(new FakeWorkerPool(), {
      expectedLoginRole: "authenticated",
    });
  } catch (error) {
    invalidRoleDenied = error instanceof WorkerDatabaseSessionError &&
      error.code === "WORKER_DATABASE_ROLE_NOT_CONFIGURED";
  }
  if (!invalidRoleDenied) {
    throw new Error("A human/shared role must not be accepted as the dedicated worker login.");
  }

  const pool = new FakeWorkerPool();
  const sessions = new PostgresWorkerDatabaseSessionProvider(pool, {
    expectedLoginRole: "happy_worker_dispatch",
  });
  const value = await sessions.withTransaction(async (client) => {
    await client.query("select private.happy_worker_contract_probe()");
    return "verified";
  });
  const client = pool.clients[0];
  const sql = client.statements.map((entry) => entry.sql);
  if (value !== "verified" ||
      !sql.includes("BEGIN") ||
      !sql.some((statement) => statement.includes("session_user::text") && statement.includes("current_user::text")) ||
      !sql.some((statement) => statement.includes("statement_timeout")) ||
      !sql.includes("COMMIT") ||
      !client.released) {
    throw new Error("Dedicated worker DB session did not verify and cleanly commit.");
  }
  if (sql.some((statement) =>
    statement.includes("SET LOCAL ROLE") ||
    statement.includes("request.jwt.claim") ||
    statement.includes("set_config('request.jwt.claim"),
  )) {
    throw new Error("Worker DB session must not impersonate authenticated user identity.");
  }

  const sessionMismatchPool = new FakeWorkerPool("authenticated", "authenticated");
  const sessionMismatch = new PostgresWorkerDatabaseSessionProvider(sessionMismatchPool, {
    expectedLoginRole: "happy_worker_dispatch",
  });
  let sessionDenied = false;
  let callbackRan = false;
  try {
    await sessionMismatch.withTransaction(async () => {
      callbackRan = true;
    });
  } catch (error) {
    sessionDenied = error instanceof WorkerDatabaseSessionError &&
      error.code === "WORKER_DATABASE_PRINCIPAL_MISMATCH";
  }
  const mismatchClient = sessionMismatchPool.clients[0];
  if (!sessionDenied || callbackRan ||
      !mismatchClient.statements.some((entry) => entry.sql === "ROLLBACK") ||
      mismatchClient.statements.some((entry) => entry.sql.includes("happy_worker_contract_probe")) ||
      !mismatchClient.released) {
    throw new Error("Mismatched PostgreSQL principal was not denied before broker work.");
  }

  const roleSwitchPool = new FakeWorkerPool("happy_worker_dispatch", "service_role");
  const roleSwitch = new PostgresWorkerDatabaseSessionProvider(roleSwitchPool, {
    expectedLoginRole: "happy_worker_dispatch",
  });
  let roleSwitchDenied = false;
  try {
    await roleSwitch.withTransaction(async () => {
      throw new Error("callback must not run");
    });
  } catch (error) {
    roleSwitchDenied = error instanceof WorkerDatabaseSessionError &&
      error.code === "WORKER_DATABASE_PRINCIPAL_MISMATCH";
  }
  if (!roleSwitchDenied) {
    throw new Error("A connection switched into another role must be denied.");
  }

  console.log("PostgreSQL worker database session contract: PASS (fake pool; no live PostgreSQL)");
  console.log({
    dedicatedLoginRoleRequired: true,
    sessionUserAndCurrentUserVerified: true,
    authenticatedUserImpersonationAbsent: true,
    mismatchedPrincipalDeniedBeforeOperation: true,
    rollbackAndConnectionRelease: true,
    livePostgresPrincipalVerification: "NOT_RUN",
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
