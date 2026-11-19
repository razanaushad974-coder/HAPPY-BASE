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
  assert(consumed, "A matching returned grant row was not accepted.");
  assert(query.updateCount === 1, "Grant consumption must be exactly one UPDATE.");
  assert(tables.length === 1 && tables[0] === "file_mutation_approval_grants", "Unexpected table access.");
  for (const [column, value] of [
    ["grant_id", "grant-1"],
    ["organization_id", "org-1"],
    ["workspace_id", "workspace-1"],
    ["request_id", "request-1"],
    ["task_id", "task-1"],
    ["mission_id", "mission-1"],
    ["requester_user_id", "requester-1"],
    ["executor_user_id", "executor-1"],
    ["approver_user_id", "approver-1"],
    ["target_entity_type", "FILE"],
    ["target_entity_id", "file-1"],
    ["operation", "MODIFY"],
    ["source_path", "docs/plan.md"],
    ["input_digest", "a".repeat(64)],
    ["status", "APPROVED"],
  ] as const) {
    assert(query.calls.some((call) => call[0] === "eq" && call[1] === column && call[2] === value),
      `Missing exact consume predicate: ${column}`);
  }
  assert(query.calls.some((call) => call[0] === "is" && call[1] === "consumed_at" && call[2] === null),
    "Consume must require consumed_at IS NULL.");
  assert(query.calls.some((call) => call[0] === "is" && call[1] === "destination_path" && call[2] === null),
    "Null destination path was not matched with IS NULL.");
  assert(query.calls.some((call) => call[0] === "gt" && call[1] === "expires_at"),
    "Consume must require an unexpired grant.");
  assert(query.calls.some((call) => call[0] === "select" && call[1] === "grant_id"),
    "Consume must use RETURNING grant_id.");

  query.result = { data: null, error: null };
  assert(!(await store.consumeApprovedGrant(
    { organizationId: "org-1", workspaceId: "workspace-1" },
    "grant-1",
    binding,
    "2026-11-19T12:00:01.000Z",
  )), "A zero-row conditional update must deny consumption.");

  const membershipQuery = new FakeQuery();
  membershipQuery.result = {
    data: {
      user_id: "executor-1",
      organization_id: "org-1",
      status: "ACTIVE",
      role: "MEMBER",
    },
    error: null,
  };
  const membershipClient = {
    schema() {
      return { from: () => membershipQuery };
    },
  } as unknown as SupabasePrivateSchemaClient;
  const memberships = new SupabaseCanonicalTenantMembershipStore(membershipClient);
  const member = await memberships.getOrganizationMembership("executor-1", "org-1");
  assert(member?.userId === "executor-1" && member.status === "ACTIVE",
    "Active membership row was not mapped.");
  assert(membershipQuery.calls.some((call) => call[0] === "eq" && call[1] === "user_id" && call[2] === "executor-1"),
    "Membership query did not constrain the verified user.");
  assert(membershipQuery.calls.some((call) => call[0] === "eq" && call[1] === "organization_id" && call[2] === "org-1"),
    "Membership query did not constrain the requested organization.");

  console.log("Supabase private tenant/grant adapter contract: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
