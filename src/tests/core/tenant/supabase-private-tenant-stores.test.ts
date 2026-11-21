import {
  SupabaseCanonicalTenantMembershipStore,
  SupabaseNamedExecutorGrantStore,
  type SupabasePrivateQuery,
  type SupabasePrivateSchemaClient,
} from "../../../core/tenant/supabase-private-tenant-stores";
import type { NamedExecutorGrantBinding } from "../../../core/approval/named-executor-file-mutation-authorizer";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

class FakeQuery implements SupabasePrivateQuery {
  readonly calls: Array<[string, string, unknown]> = [];
  updateCount = 0;
  result: { data: unknown; error: { message?: string } | null } = {
    data: { grant_id: "grant-1" },
    error: null,
  };

  select(columns: string): SupabasePrivateQuery {
    this.calls.push(["select", columns, null]);
    return this;
  }
  update(values: Record<string, unknown>): SupabasePrivateQuery {
    this.updateCount += 1;
    this.calls.push(["update", JSON.stringify(values), null]);
    return this;
  }
  eq(column: string, value: string | number | boolean): SupabasePrivateQuery {
    this.calls.push(["eq", column, value]);
    return this;
  }
  is(column: string, value: null | boolean): SupabasePrivateQuery {
    this.calls.push(["is", column, value]);
    return this;
  }
  gt(column: string, value: string): SupabasePrivateQuery {
    this.calls.push(["gt", column, value]);
    return this;
  }
  async maybeSingle(): Promise<{ data: unknown; error: { message?: string } | null }> {
    return this.result;
  }
}

async function main(): Promise<void> {
  const query = new FakeQuery();
  const tables: string[] = [];
  const client = {
    schema(name: "private") {
      assert(name === "private", "Adapter accessed a non-private schema.");
      return {
        from(table: string) {
          tables.push(table);
          return query;
        },
      };
    },
  } as SupabasePrivateSchemaClient;

  const binding: NamedExecutorGrantBinding = {
    requestId: "request-1",
    taskId: "task-1",
    missionId: "mission-1",
    requesterUserId: "requester-1",
    executorUserId: "executor-1",
    approverUserId: "approver-1",
    organizationId: "org-1",
    workspaceId: "workspace-1",
    targetEntityType: "FILE",
    targetEntityId: "file-1",
    operation: "MODIFY",
    sourcePath: "docs/plan.md",
    destinationPath: null,
    inputDigest: "a".repeat(64),
  };

  const store = new SupabaseNamedExecutorGrantStore(client);
  const consumed = await store.consumeApprovedGrant(
    { organizationId: "org-1", workspaceId: "workspace-1" },
    "grant-1",
    binding,
    "2026-11-19T12:00:00.000Z",
  );
  assert(!consumed, "Direct private-table consumption must be disabled; use the auth.uid()-bound RPC.");
  assert(query.updateCount === 0, "The lookup adapter must never directly UPDATE approval grants.");
  assert(tables.length === 0, "Direct consume must not access the private grant table.");

  query.result = { data: null, error: null };
  assert(!(await store.consumeApprovedGrant(
    { organizationId: "org-1", workspaceId: "workspace-1" },
    "grant-1",
    binding,
    "2026-11-19T12:00:01.000Z",
  )), "A zero-row conditional update must deny consumption.");

  const rpcCalls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
  const memberships = new SupabaseCanonicalTenantMembershipStore({
    async rpc(functionName, args) {
      rpcCalls.push({ functionName, args });
      return {
        data: [{
          user_id: "executor-1",
          organization_id: "org-1",
          workspace_id: "workspace-1",
          organization_role: "MEMBER",
          workspace_role: "OWNER",
        }],
        error: null,
      };
    },
  });
  const pair = await memberships.getTenantMembershipPair("executor-1", "org-1", "workspace-1");
  assert(pair?.organization.userId === "executor-1" && pair.organization.status === "ACTIVE",
    "Active organization membership was not mapped from the trusted RPC.");
  assert(pair?.workspace.workspaceId === "workspace-1" && pair.workspace.role === "OWNER",
    "Active workspace membership was not mapped from the trusted RPC.");
  const capturedRpc = rpcCalls[0];
  assert(capturedRpc?.functionName === "resolve_authenticated_tenant_context", "Unexpected tenant membership RPC.");
  assert(capturedRpc.args.p_organization_id === "org-1" && capturedRpc.args.p_workspace_id === "workspace-1",
    "Tenant membership RPC was not bound to the exact requested scope.");
  assert(!("user_id" in capturedRpc.args), "Caller-supplied user ID must not be sent to auth.uid()-bound RPC.");

  const mismatchedMemberships = new SupabaseCanonicalTenantMembershipStore({
    async rpc() {
      return {
        data: [{
          user_id: "other-user",
          organization_id: "org-1",
          workspace_id: "workspace-1",
          organization_role: "MEMBER",
          workspace_role: "OWNER",
        }],
        error: null,
      };
    },
  });
  assert(await mismatchedMemberships.getTenantMembershipPair("executor-1", "org-1", "workspace-1") === null,
    "Membership RPC result for a different authenticated user was accepted.");

  const failedMemberships = new SupabaseCanonicalTenantMembershipStore({
    async rpc() { return { data: null, error: { message: "private schema unavailable" } }; },
  });
  assert(await failedMemberships.getTenantMembershipPair("executor-1", "org-1", "workspace-1") === null,
    "Membership RPC error did not fail closed.");

  console.log("Supabase private tenant/grant adapter contract: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
