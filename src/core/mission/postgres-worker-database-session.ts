import type {
  PgClientLike,
  PgPoolLike,
  PgQueryable,
} from "../persistence/adapters/postgres-tenant-adapter";

export type WorkerDatabaseSessionErrorCode =
  | "WORKER_DATABASE_ROLE_NOT_CONFIGURED"
  | "WORKER_DATABASE_PRINCIPAL_MISMATCH"
  | "WORKER_DATABASE_SESSION_FAILED";

export class WorkerDatabaseSessionError extends Error {
  constructor(readonly code: WorkerDatabaseSessionErrorCode) {
    super(code);
    this.name = "WorkerDatabaseSessionError";
  }
}

export interface WorkerDatabaseSessionOptions {
  /** Server-owned PostgreSQL LOGIN role; never derive this from a request. */
  expectedLoginRole: string;
  statementTimeoutMs?: number;
  idleTransactionTimeoutMs?: number;
}

interface DatabasePrincipalRow {
  session_user: string;
  current_user: string;
}

/**
 * Establishes a transaction only when PostgreSQL itself reports the dedicated
 * worker LOGIN role as both session_user and current_user.
 *
 * Unlike the human tenant session provider, this provider never executes
 * SET ROLE authenticated, never sets auth.uid()/JWT claim GUCs, and never
 * accepts a worker principal supplied by an application caller.
 *
 * This proves only the connected database login boundary. Worker registry,
 * tenant membership, approval, and task/outbox authorization must still be
 * enforced transactionally by dedicated database functions.
 */
export class PostgresWorkerDatabaseSessionProvider {
  private readonly statementTimeoutMs: number;
  private readonly idleTransactionTimeoutMs: number;
  private readonly expectedLoginRole: string;

  constructor(
    private readonly pool: PgPoolLike,
    options: WorkerDatabaseSessionOptions,
  ) {
    const role = options?.expectedLoginRole;
    if (typeof role !== "string" || !/^happy_worker_[a-z0-9_]{1,48}$/.test(role)) {
      throw new WorkerDatabaseSessionError("WORKER_DATABASE_ROLE_NOT_CONFIGURED");
    }
    this.expectedLoginRole = role;
    this.statementTimeoutMs = options.statementTimeoutMs ?? 15_000;
    this.idleTransactionTimeoutMs = options.idleTransactionTimeoutMs ?? 30_000;
    if (!Number.isSafeInteger(this.statementTimeoutMs) || this.statementTimeoutMs < 1 ||
        !Number.isSafeInteger(this.idleTransactionTimeoutMs) || this.idleTransactionTimeoutMs < 1) {
      throw new RangeError("Worker PostgreSQL session timeouts must be positive integer milliseconds.");
    }
  }

  withSession<T>(operation: (client: PgQueryable) => Promise<T>): Promise<T> {
    return this.withTransaction(operation);
  }

  async withTransaction<T>(operation: (client: PgQueryable) => Promise<T>): Promise<T> {
    let client: PgClientLike;
    try {
      client = await this.pool.connect();
    } catch {
      throw new WorkerDatabaseSessionError("WORKER_DATABASE_SESSION_FAILED");
    }

    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;

      const principal = await client.query<DatabasePrincipalRow>(
        "select session_user::text as session_user, current_user::text as current_user",
      );
      const row = principal.rows[0];
      if (!row ||
          row.session_user !== this.expectedLoginRole ||
          row.current_user !== this.expectedLoginRole) {
        throw new WorkerDatabaseSessionError("WORKER_DATABASE_PRINCIPAL_MISMATCH");
      }

      await client.query(
        "select set_config('statement_timeout', $1, true), set_config('idle_in_transaction_session_timeout', $2, true)",
        [`${this.statementTimeoutMs}ms`, `${this.idleTransactionTimeoutMs}ms`],
      );

      const result = await operation(client);
      await client.query("COMMIT");
      transactionOpen = false;
      return result;
    } catch (error) {
      if (transactionOpen) {
        try {
          await client.query("ROLLBACK");
        } catch {
          // Preserve the original authorization/query/callback failure.
        }
      }
      if (error instanceof WorkerDatabaseSessionError) throw error;
      throw new WorkerDatabaseSessionError("WORKER_DATABASE_SESSION_FAILED");
    } finally {
      client.release();
    }
  }
}
