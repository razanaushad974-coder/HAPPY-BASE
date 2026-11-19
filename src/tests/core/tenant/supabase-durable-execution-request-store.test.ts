import {
  SupabaseDurableExecutionRequestStore,
} from "../../../core/tenant/supabase-named-executor-context-provider";
import type {
  SupabasePrivateQuery,
  SupabasePrivateSchemaClient,
} from "../../../core/tenant/supabase-private-tenant-stores";

type Row = Record<string, unknown>;

class Query implements SupabasePrivateQuery {
  private filters: Array<[string, unknown]> = [];
  constructor(private readonly row: Row | null, private readonly table: string) {}
  select(_columns: string): SupabasePrivateQuery { return this; }
  update(_values: Record<string, unknown>): SupabasePrivateQuery { return this; }
  eq(column: string, value: string | number | boolean): SupabasePrivateQuery {
    this.filters.push([column, value]); return this;
  }
  is(column: string, value: null | boolean): SupabasePrivateQuery {
    this.filters.push([column, value]); return this;
  }
  gt(column: string, value: string): SupabasePrivateQuery {
    this.filters.push([column, value]); return this;
  }
  async maybeSingle() {
    if (this.table !== "execution_requests" ||
        this.filters.some(([key, value]) => this.row?.[key] !== value)) {
      return { data: null, error: null };
    }
    return { data: this.row, error: null };
  }
}

async function main(): Promise<void> {
  const row = {
    request_id: "req-1", task_id: "task-1", mission_id: "mission-1",
    requester_user_id: "requester-1", executor_user_id: "executor-1",
    organization_id: "org-1", workspace_id: "workspace-1",
  };
  let selectedTable = "";
  const client: SupabasePrivateSchemaClient = {
    schema(name) {
      if (name !== "private") throw new Error("Only private schema is allowed.");
      return {
        from(table) {
          selectedTable = table;
          return new Query(row, table);
        },
      };
    },
  };
  const store = new SupabaseDurableExecutionRequestStore(client);
  const record = await store.getByRequestId("req-1");
  if (!record || record.requesterUserId !== "requester-1" ||
      record.executorUserId !== "executor-1" || selectedTable !== "execution_requests") {
    throw new Error("Durable execution request must map exact private row principals.");
  }
  if (await store.getByRequestId("different-request") !== null) {
    throw new Error("A mismatched request id must not resolve a durable request.");
  }

  const malformedClient: SupabasePrivateSchemaClient = {
    schema() {
      return { from(table) { return new Query({ ...row, executor_user_id: null }, table); } };
    },
  };
  if (await new SupabaseDurableExecutionRequestStore(malformedClient).getByRequestId("req-1") !== null) {
    throw new Error("Incomplete durable request rows must fail closed.");
  }
  console.log("Supabase durable execution request store: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
