import type { VerifiedServerIdentityProvider, VerifiedTenantIdentity } from "../../tenant/canonical-tenant-context";
import type { TenantScope } from "../../state/types";
import {
  requireCompleteScope,
  TenantBoundTransactionAdapter,
  TenantPersistenceError,
  type AsyncTenantPersistenceAdapter,
  type TenantPersistedRecord,
  type TenantRecordQuery,
} from "../async-tenant-repository";
import type { EntityType } from "../types";

export interface PgQueryResult<Row> {
  rows: Row[];
  rowCount: number | null;
}

export interface PgQueryable {
  query<Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<Row>>;
}

export interface PgClientLike extends PgQueryable {
  release(): void;
}

export interface PgPoolLike {
  connect(): Promise<PgClientLike>;
}

type CompleteTenantScope = TenantScope & { userId: string };

interface TenantDbRow {
  organization_id: string;
  workspace_id: string;
  user_id: string;
  entity_type: EntityType;
  record_id: string;
  version: number | string;
  data: unknown;
  created_at: string | Date;
  updated_at: string | Date;
}

export interface PostgresTenantSessionProvider {
  /** One authenticated, short-lived transaction for a single repository operation. */
  withSession<T>(
    scope: CompleteTenantScope,
    operation: (client: PgQueryable) => Promise<T>,
  ): Promise<T>;

  /** One authenticated PostgreSQL connection/transaction for the whole callback. */
  withTransaction<T>(
    scope: CompleteTenantScope,
    operation: (client: PgQueryable) => Promise<T>,
  ): Promise<T>;
}

/**
 * Establishes a database session as the authenticated role using a principal
 * obtained from a trusted server identity provider, never from request payload.
 *
 * The pool's login role must be deliberately provisioned to SET ROLE
 * authenticated and must not be service_role. Supabase/Postgres grants, role
 * membership, JWT claim GUC behavior, and function ownership require deployment
 * review. This class does not authenticate a JWT itself.
 */
export interface PgTenantSessionOptions {
  statementTimeoutMs?: number;
  idleTransactionTimeoutMs?: number;
}

export class PgPoolTenantSessionProvider implements PostgresTenantSessionProvider {
  private readonly statementTimeoutMs: number;
  private readonly idleTransactionTimeoutMs: number;

  constructor(
    private readonly pool: PgPoolLike,
    private readonly identities: VerifiedServerIdentityProvider,
    options: PgTenantSessionOptions = {},
  ) {
    this.statementTimeoutMs = options.statementTimeoutMs ?? 15_000;
    this.idleTransactionTimeoutMs = options.idleTransactionTimeoutMs ?? 30_000;
    if (!Number.isInteger(this.statementTimeoutMs) || this.statementTimeoutMs < 1 ||
        !Number.isInteger(this.idleTransactionTimeoutMs) || this.idleTransactionTimeoutMs < 1) {
      throw new RangeError("PostgreSQL session timeouts must be positive integer milliseconds.");
    }
  }

  withSession<T>(
    scope: CompleteTenantScope,
    operation: (client: PgQueryable) => Promise<T>,
  ): Promise<T> {
    return this.withTransaction(scope, operation);
  }

  async withTransaction<T>(
    scope: CompleteTenantScope,
    operation: (client: PgQueryable) => Promise<T>,
  ): Promise<T> {
    requireCompleteScope(scope);

    let identity: VerifiedTenantIdentity | null;
    try {
      identity = await this.identities.getVerifiedIdentity();
    } catch {
      throw new TenantPersistenceError("INVALID_TENANT_SCOPE", "Verified database identity is unavailable.");
    }
    if (!identity?.userId?.trim() || identity.userId !== scope.userId) {
      throw new TenantPersistenceError("INVALID_TENANT_SCOPE", "Tenant scope does not match the verified server principal.");
    }

    const client = await this.pool.connect();
    let transactionOpen = false;
    try {
      await client.query("BEGIN");
      transactionOpen = true;
      await client.query("SET LOCAL ROLE authenticated");
      await client.query(
        "select set_config('request.jwt.claim.sub', $1, true), set_config('request.jwt.claims', json_build_object('sub', $1, 'role', 'authenticated')::text, true), set_config('statement_timeout', $2, true), set_config('idle_in_transaction_session_timeout', $3, true)",
        [identity.userId, `${this.statementTimeoutMs}ms`, `${this.idleTransactionTimeoutMs}ms`],
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
          // Preserve the original query/callback failure.
        }
      }
      throw error;
    } finally {
      client.release();
    }
  }
}

function validateRecordInput<T>(id: string, data: T): string {
  if (!id.trim() || typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new TenantPersistenceError(
      "INVALID_RECORD_DATA",
      "Record ID must be non-empty and record data must be a JSON object.",
    );
  }
  const serialized = JSON.stringify(data);
  if (serialized === undefined) {
    throw new TenantPersistenceError("INVALID_RECORD_DATA", "Record data is not JSON serializable.");
  }
  return serialized;
}

function timestamp(value: string | Date): string {
  const date = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new Error("PostgreSQL returned an invalid record timestamp.");
  }
  return date.toISOString();
}

function toRecord<T>(row: TenantDbRow): TenantPersistedRecord<T> {
  const version = Number(row.version);
  if (!Number.isSafeInteger(version) || version < 1) {
    throw new Error("PostgreSQL returned an invalid record version.");
  }
  let data = row.data;
  if (typeof data === "string") {
    data = JSON.parse(data) as unknown;
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    throw new Error("PostgreSQL returned a non-object entity payload.");
  }
  return {
    id: row.record_id,
    entityType: row.entity_type,
    version,
    createdAt: timestamp(row.created_at),
    updatedAt: timestamp(row.updated_at),
    organizationId: row.organization_id,
    workspaceId: row.workspace_id,
    userId: row.user_id,
    data: data as T,
  };
}

function throwMappedDatabaseError(error: unknown): never {
  const code = typeof error === "object" && error !== null && "code" in error
    ? String((error as { code: unknown }).code)
    : "";
  if (code === "23505") {
    throw new TenantPersistenceError("RECORD_ALREADY_EXISTS");
  }
  if (code === "40001") {
    throw new TenantPersistenceError("VERSION_CONFLICT");
  }
  if (code === "P0002") {
    throw new TenantPersistenceError("RECORD_NOT_FOUND");
  }
  if (code === "42501") {
    throw new TenantPersistenceError("INVALID_TENANT_SCOPE");
  }
  if (code === "22023") {
    throw new TenantPersistenceError("INVALID_RECORD_DATA");
  }
  throw error;
}

class PostgresTransactionAdapter implements AsyncTenantPersistenceAdapter {
  constructor(
    private readonly scope: CompleteTenantScope,
    private readonly client: PgQueryable,
    private readonly savepointSequence: { value: number } = { value: 0 },
  ) {}

  private assertScope(scope: CompleteTenantScope): void {
    if (
      scope.organizationId !== this.scope.organizationId ||
      scope.workspaceId !== this.scope.workspaceId ||
      scope.userId !== this.scope.userId
    ) {
      throw new TenantPersistenceError("INVALID_TENANT_SCOPE");
    }
  }

  async get<T>(
    scope: CompleteTenantScope,
    entityType: EntityType,
    id: string,
  ): Promise<TenantPersistedRecord<T> | undefined> {
    this.assertScope(scope);
    const result = await this.client.query<TenantDbRow>(
      `select organization_id, workspace_id, user_id, entity_type, record_id,
              version, data, created_at, updated_at
         from public.happy_tenant_records
        where organization_id = $1
          and workspace_id = $2
          and user_id = auth.uid()
          and entity_type = $3
          and record_id = $4
        limit 1`,
      [this.scope.organizationId, this.scope.workspaceId, entityType, id],
    );
    return result.rows[0] ? toRecord<T>(result.rows[0]) : undefined;
  }

  async list<T>(
    scope: CompleteTenantScope,
    query: TenantRecordQuery = {},
  ): Promise<TenantPersistedRecord<T>[]> {
    this.assertScope(scope);
    const limit = query.limit ?? 100;
    if (!Number.isInteger(limit) || limit < 1 || limit > 500) {
      throw new RangeError("Tenant record list limit must be an integer between 1 and 500.");
    }
    const result = await this.client.query<TenantDbRow>(
      `select organization_id, workspace_id, user_id, entity_type, record_id,
              version, data, created_at, updated_at
         from public.happy_tenant_records
        where organization_id = $1
          and workspace_id = $2
          and user_id = auth.uid()
          and ($3::text is null or entity_type = $3)
        order by updated_at desc, record_id
        limit $4`,
      [this.scope.organizationId, this.scope.workspaceId, query.entityType ?? null, limit],
    );
    return result.rows.map((row) => toRecord<T>(row));
  }

  async create<T>(
    scope: CompleteTenantScope,
    entityType: EntityType,
    id: string,
    data: T,
  ): Promise<TenantPersistedRecord<T>> {
    this.assertScope(scope);
    const serialized = validateRecordInput(id, data);
    try {
      const result = await this.client.query<TenantDbRow>(
        "select * from public.happy_create_tenant_record($1, $2, $3, $4, $5::jsonb)",
        [this.scope.organizationId, this.scope.workspaceId, entityType, id, serialized],
      );
      if (!result.rows[0]) throw new Error("PostgreSQL create returned no record.");
      return toRecord<T>(result.rows[0]);
    } catch (error) {
      return throwMappedDatabaseError(error);
    }
  }

  async update<T>(
    scope: CompleteTenantScope,
    entityType: EntityType,
    id: string,
    expectedVersion: number,
    data: T,
  ): Promise<TenantPersistedRecord<T>> {
    this.assertScope(scope);
    const serialized = validateRecordInput(id, data);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new TenantPersistenceError("VERSION_CONFLICT");
    }
    try {
      const result = await this.client.query<TenantDbRow>(
        "select * from public.happy_update_tenant_record($1, $2, $3, $4, $5, $6::jsonb)",
        [
          this.scope.organizationId,
          this.scope.workspaceId,
          entityType,
          id,
          expectedVersion,
          serialized,
        ],
      );
      if (!result.rows[0]) throw new Error("PostgreSQL CAS update returned no record.");
      return toRecord<T>(result.rows[0]);
    } catch (error) {
      return throwMappedDatabaseError(error);
    }
  }

  async delete(
    scope: CompleteTenantScope,
    entityType: EntityType,
    id: string,
    expectedVersion: number,
  ): Promise<boolean> {
    this.assertScope(scope);
    if (!Number.isSafeInteger(expectedVersion) || expectedVersion < 1) {
      throw new TenantPersistenceError("VERSION_CONFLICT");
    }
    try {
      const result = await this.client.query<{ deleted: boolean }>(
        "select public.happy_delete_tenant_record($1, $2, $3, $4, $5) as deleted",
        [this.scope.organizationId, this.scope.workspaceId, entityType, id, expectedVersion],
      );
      return result.rows[0]?.deleted === true;
    } catch (error) {
      return throwMappedDatabaseError(error);
    }
  }

  async transaction<T>(
    scope: CompleteTenantScope,
    operation: (transaction: AsyncTenantPersistenceAdapter) => Promise<T>,
  ): Promise<T> {
    this.assertScope(scope);
    const savepoint = `happy_nested_${++this.savepointSequence.value}`;
    await this.client.query(`SAVEPOINT ${savepoint}`);
    try {
      const result = await operation(
        new TenantBoundTransactionAdapter(
          this.scope,
          new PostgresTransactionAdapter(this.scope, this.client, this.savepointSequence),
        ),
      );
      await this.client.query(`RELEASE SAVEPOINT ${savepoint}`);
      return result;
    } catch (error) {
      try {
        await this.client.query(`ROLLBACK TO SAVEPOINT ${savepoint}`);
        await this.client.query(`RELEASE SAVEPOINT ${savepoint}`);
      } catch {
        // Preserve the callback/query failure; the outer transaction will roll back.
      }
      throw error;
    }
  }
}

/**
 * PostgreSQL-backed implementation of AsyncTenantPersistenceAdapter.
 *
 * The injected session provider must establish a verified user-bound
 * authenticated DB session. Transactions run the entire callback on one
 * acquired PostgreSQL connection and roll back on callback/query failure.
 * This adapter is not production-ready until the accompanying SQL candidate,
 * role grants, verified identity provider, and real PostgreSQL tests are
 * reviewed and deployed together.
 */
export class PostgresTenantPersistenceAdapter implements AsyncTenantPersistenceAdapter {
  constructor(private readonly sessions: PostgresTenantSessionProvider) {}

  private validateScope(scope: TenantScope): asserts scope is CompleteTenantScope {
    requireCompleteScope(scope);
  }

  async get<T>(scope: CompleteTenantScope, entityType: EntityType, id: string) {
    this.validateScope(scope);
    return this.sessions.withSession(scope, (client) =>
      new PostgresTransactionAdapter(scope, client).get<T>(scope, entityType, id),
    );
  }

  async list<T>(scope: CompleteTenantScope, query?: TenantRecordQuery) {
    this.validateScope(scope);
    return this.sessions.withSession(scope, (client) =>
      new PostgresTransactionAdapter(scope, client).list<T>(scope, query),
    );
  }

  async create<T>(scope: CompleteTenantScope, entityType: EntityType, id: string, data: T) {
    this.validateScope(scope);
    return this.sessions.withSession(scope, (client) =>
      new PostgresTransactionAdapter(scope, client).create(scope, entityType, id, data),
    );
  }

  async update<T>(
    scope: CompleteTenantScope,
    entityType: EntityType,
    id: string,
    expectedVersion: number,
    data: T,
  ) {
    this.validateScope(scope);
    return this.sessions.withSession(scope, (client) =>
      new PostgresTransactionAdapter(scope, client).update(
        scope, entityType, id, expectedVersion, data,
      ),
    );
  }

  async delete(
    scope: CompleteTenantScope,
    entityType: EntityType,
    id: string,
    expectedVersion: number,
  ) {
    this.validateScope(scope);
    return this.sessions.withSession(scope, (client) =>
      new PostgresTransactionAdapter(scope, client).delete(
        scope, entityType, id, expectedVersion,
      ),
    );
  }

  async transaction<T>(
    scope: CompleteTenantScope,
    operation: (transaction: AsyncTenantPersistenceAdapter) => Promise<T>,
  ): Promise<T> {
    this.validateScope(scope);
    return this.sessions.withTransaction(scope, async (client) =>
      operation(
        new TenantBoundTransactionAdapter(
          scope,
          new PostgresTransactionAdapter(scope, client),
        ),
      ),
    );
  }
}
