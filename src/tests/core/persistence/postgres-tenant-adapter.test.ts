import { TenantPersistenceError } from "../../../core/persistence/async-tenant-repository";
import {
  PgPoolTenantSessionProvider,
  PostgresTenantPersistenceAdapter,
  type PgClientLike,
  type PgPoolLike,
  type PgQueryResult,
} from "../../../core/persistence/adapters/postgres-tenant-adapter";

const scope = {
  organizationId: "10000000-0000-4000-8000-000000000001",
  workspaceId: "20000000-0000-4000-8000-000000000002",
  userId: "30000000-0000-4000-8000-000000000003",
};

const dbRow = {
  organization_id: scope.organizationId,
  workspace_id: scope.workspaceId,
  user_id: scope.userId,
  entity_type: "MISSION" as const,
  record_id: "mission-1",
  version: 1,
  data: { goal: "atomic postgres persistence" },
  created_at: "2026-11-19T12:00:00.000Z",
  updated_at: "2026-11-19T12:00:00.000Z",
};

class FakePgClient implements PgClientLike {
  readonly statements: Array<{ sql: string; values?: readonly unknown[] }> = [];
  released = false;
  failNextRpcCode: string | undefined;

  async query<Row = Record<string, unknown>>(
    sql: string,
    values?: readonly unknown[],
  ): Promise<PgQueryResult<Row>> {
    this.statements.push({ sql, values });
    if (sql.includes("happy_update_tenant_record") && this.failNextRpcCode) {
      const code = this.failNextRpcCode;
      this.failNextRpcCode = undefined;
      throw Object.assign(new Error(code), { code });
    }
    if (sql.includes("happy_delete_tenant_record")) {
      return { rows: [{ deleted: true } as Row], rowCount: 1 };
    }
    if (sql.includes("happy_update_tenant_record")) {
      return { rows: [{ ...dbRow, version: 2, data: { goal: "updated" } } as Row], rowCount: 1 };
    }
    if (sql.includes("insert into public.happy_tenant_records")) {
      return { rows: [dbRow as Row], rowCount: 1 };
    }
    if (sql.includes("from public.happy_tenant_records")) {
      return { rows: [dbRow as Row], rowCount: 1 };
    }
    return { rows: [], rowCount: 0 };
  }

  release(): void {
    this.released = true;
  }
}

class FakePgPool implements PgPoolLike {
  readonly clients: FakePgClient[] = [];
  failNextRpcCode: string | undefined;

  async connect(): Promise<PgClientLike> {
    const client = new FakePgClient();
    client.failNextRpcCode = this.failNextRpcCode;
    this.failNextRpcCode = undefined;
    this.clients.push(client);
    return client;
  }
}

async function main(): Promise<void> {
  const pool = new FakePgPool();
  let verifiedUserId: string | null = scope.userId;
  const sessions = new PgPoolTenantSessionProvider(pool, {
    async getVerifiedIdentity() {
      return verifiedUserId ? { userId: verifiedUserId } : null;
    },
  });
  const adapter = new PostgresTenantPersistenceAdapter(sessions);

  const created = await adapter.create(scope, "MISSION", "mission-1", {
    goal: "atomic postgres persistence",
  });
  if (created.version !== 1 || created.userId !== scope.userId) {
    throw new Error("PostgreSQL adapter did not map the inserted tenant record.");
  }
  const createClient = pool.clients[0];
  const insert = createClient.statements.find((entry) =>
    entry.sql.includes("insert into public.happy_tenant_records"),
  );
  if (!insert?.sql.includes("auth.uid()") || insert.values?.includes(scope.userId)) {
    throw new Error("PostgreSQL create trusted a caller-supplied user ID.");
  }
  if (!createClient.statements.some((entry) => entry.sql === "SET LOCAL ROLE authenticated") ||
      !createClient.statements.some((entry) => entry.sql.includes("request.jwt.claim.sub")) ||
      !createClient.statements.some((entry) => entry.sql === "COMMIT") ||
      !createClient.released) {
    throw new Error("PostgreSQL user session was not established and cleaned up.");
  }

  const fetched = await adapter.get(scope, "MISSION", "mission-1");
  const listed = await adapter.list(scope, { entityType: "MISSION", limit: 20 });
  if (fetched?.id !== "mission-1" || listed.length !== 1) {
    throw new Error("PostgreSQL tenant-scoped get/list mapping failed.");
  }
  const readSql = pool.clients[1].statements.find((entry) =>
    entry.sql.includes("from public.happy_tenant_records"),
  )?.sql ?? "";
  if (!readSql.includes("user_id = auth.uid()") ||
      !readSql.includes("organization_id = $1") ||
      !readSql.includes("workspace_id = $2")) {
    throw new Error("PostgreSQL read was not constrained by the complete authenticated tenant scope.");
  }

  const updated = await adapter.update(scope, "MISSION", "mission-1", 1, { goal: "updated" });
  if (updated.version !== 2 || updated.data.goal !== "updated") {
    throw new Error("PostgreSQL CAS update result mapping failed.");
  }
  const updateSql = pool.clients[3].statements.find((entry) =>
    entry.sql.includes("happy_update_tenant_record"),
  );
  if (!updateSql || updateSql.values?.[4] !== 1) {
    throw new Error("PostgreSQL update did not pass the expected version to the CAS RPC.");
  }

  pool.failNextRpcCode = "40001";
  let staleConflict = false;
  try {
    await adapter.update(scope, "MISSION", "mission-1", 1, { goal: "stale" });
  } catch (error) {
    staleConflict = error instanceof TenantPersistenceError && error.code === "VERSION_CONFLICT";
  }
  if (!staleConflict) throw new Error("PostgreSQL CAS conflict was not mapped to VERSION_CONFLICT.");

  if (!(await adapter.delete(scope, "MISSION", "mission-1", 2))) {
    throw new Error("PostgreSQL CAS delete did not return its deleted status.");
  }

  const beforeTransactionConnections = pool.clients.length;
  await adapter.transaction(scope, async (tx) => {
    await tx.create(scope, "MISSION", "transaction-mission", { goal: "same connection" });
    await tx.create(scope, "TASK", "transaction-task", { missionId: "transaction-mission" });
    await tx.transaction(scope, async (nested) => {
      await nested.create(scope, "EVIDENCE", "transaction-evidence", { proof: "nested savepoint" });
    });
  });
  const transactionClients = pool.clients.slice(beforeTransactionConnections);
  if (transactionClients.length !== 1) {
    throw new Error("PostgreSQL transaction callback did not use exactly one connection.");
  }
  const transactionSql = transactionClients[0].statements.map((entry) => entry.sql);
  if (transactionSql.filter((sql) => sql === "BEGIN").length !== 1 ||
      transactionSql.filter((sql) => sql === "COMMIT").length !== 1 ||
      !transactionSql.some((sql) => sql.startsWith("SAVEPOINT happy_nested_")) ||
      !transactionSql.some((sql) => sql.startsWith("RELEASE SAVEPOINT happy_nested_"))) {
    throw new Error("PostgreSQL transaction did not preserve one transaction and nested savepoint.");
  }

  const beforeRollback = pool.clients.length;
  let rolledBack = false;
  try {
    await adapter.transaction(scope, async (tx) => {
      await tx.create(scope, "MISSION", "rollback-mission", { goal: "rollback" });
      throw new Error("force rollback");
    });
  } catch (error) {
    rolledBack = error instanceof Error && error.message === "force rollback";
  }
  const rollbackSql = pool.clients[beforeRollback]?.statements.map((entry) => entry.sql) ?? [];
  if (!rolledBack || !rollbackSql.includes("ROLLBACK") || rollbackSql.includes("COMMIT")) {
    throw new Error("PostgreSQL transaction callback failure did not roll back.");
  }

  const beforeIdentityDenial = pool.clients.length;
  verifiedUserId = "40000000-0000-4000-8000-000000000004";
  let identityDenied = false;
  try {
    await adapter.get(scope, "MISSION", "mission-1");
  } catch (error) {
    identityDenied = error instanceof TenantPersistenceError && error.code === "INVALID_TENANT_SCOPE";
  }
  if (!identityDenied || pool.clients.length !== beforeIdentityDenial) {
    throw new Error("PostgreSQL adapter acquired a connection for a mismatched verified principal.");
  }

  console.log("PostgreSQL tenant adapter contract: PASS (fake pool; no live PostgreSQL)");
  console.log({
    verifiedPrincipalBinding: true,
    authUidScopedReadsAndCreates: true,
    atomicCasRpcMapping: true,
    oneConnectionTransaction: true,
    nestedSavepoint: true,
    rollbackOnCallbackFailure: true,
    mismatchedIdentityRejectedBeforeConnect: true,
    livePostgresIntegration: "NOT_RUN",
  });
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
