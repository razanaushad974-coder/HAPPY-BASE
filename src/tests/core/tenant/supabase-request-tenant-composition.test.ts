import {
  resolveSupabaseRequestTenantContext,
  type RequestScopedSupabaseClient,
} from "../../../core/tenant/supabase-request-tenant-composition";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const queryLog: Array<{ table: string; filters: Array<[string, string | number | boolean]> }> = [];
  const rows: Record<string, Record<string, unknown>> = {
    organization_memberships: {
      user_id: "verified-user-1",
      organization_id: "org-1",
      status: "ACTIVE",
      role: "FOUNDER",
    },
    workspace_memberships: {
      user_id: "verified-user-1",
      organization_id: "org-1",
      workspace_id: "workspace-1",
      status: "ACTIVE",
      role: "OWNER",
    },
  };

  const client: RequestScopedSupabaseClient = {
    auth: {
      async getUser() {
        return { data: { user: { id: "verified-user-1" } }, error: null };
      },
    },
    schema(name) {
      assert(name === "private", "Membership lookup used an unexpected schema.");
      return {
        from(table) {
          let selected = "";
          const filters: Array<[string, string | number | boolean]> = [];
          const query = {
            select(columns: string) { selected = columns; return query; },
            update() { throw new Error("Membership resolution must be read-only."); },
            eq(column: string, value: string | number | boolean) {
              filters.push([column, value]);
              return query;
            },
            is() { return query; },
            gt() { return query; },
            async maybeSingle() {
              queryLog.push({ table, filters: [...filters] });
              assert(Boolean(selected), "Membership query did not select explicit columns.");
              return { data: rows[table] ?? null, error: null };
            },
          };
          return query;
        },
      };
    },
  };

  let factoryCalls = 0;
  const result = await resolveSupabaseRequestTenantContext({
    async createForCurrentRequest() {
      factoryCalls += 1;
      return client;
    },
  }, { organizationId: "org-1", workspaceId: "workspace-1" });

  assert(result.status === "AUTHENTICATED", "Valid request-scoped identity and memberships were denied.");
  if (result.status === "AUTHENTICATED") {
    assert(result.context.actor.userId === "verified-user-1", "Caller identity did not come from auth.getUser().");
    assert(result.context.organizationRole === "FOUNDER", "Organization role was not resolved from membership.");
    assert(result.context.workspaceRole === "OWNER", "Workspace role was not resolved from membership.");
  }
  assert(factoryCalls === 1, "One request must create exactly one Supabase client.");
  assert(queryLog.length === 2, "Both organization and workspace membership must be checked.");
  assert(queryLog[0].filters.some(([key, value]) => key === "user_id" && value === "verified-user-1"),
    "Organization membership query was not bound to the verified principal.");
  assert(queryLog[1].filters.some(([key, value]) => key === "workspace_id" && value === "workspace-1"),
    "Workspace membership query was not bound to the exact requested workspace.");

  rows.workspace_memberships.status = "REVOKED";
  const revoked = await resolveSupabaseRequestTenantContext({
    async createForCurrentRequest() { return client; },
  }, { organizationId: "org-1", workspaceId: "workspace-1" });
  assert(revoked.status === "TENANT_ACCESS_DENIED", "Revoked workspace membership was accepted.");

  const unavailable = await resolveSupabaseRequestTenantContext({
    async createForCurrentRequest() { throw new Error("request context unavailable"); },
  }, { organizationId: "org-1", workspaceId: "workspace-1" });
  assert(unavailable.status === "UNAUTHENTICATED", "Request-client factory failure did not fail closed.");

  console.log("Supabase request tenant composition contract: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
