import { TenantMembershipUnavailableError } from "../../../core/tenant/canonical-tenant-context";
import {
  SupabaseAuthenticatedNamedExecutorGrantLookupStore,
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
  let membershipUnavailable = false;
  try {
    await failedMemberships.getTenantMembershipPair("executor-1", "org-1", "workspace-1");
  } catch (error) {
    membershipUnavailable = error instanceof TenantMembershipUnavailableError;
  }
  assert(membershipUnavailable,
    "Membership RPC infrastructure error must remain distinguishable from a missing membership row.");

  const { SupabaseTransactionalNamedExecutorGrantStore } = await import("../../../core/tenant/supabase-private-tenant-stores");
  const consumeCalls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
  let lookupCalls = 0;
  const transactional = new SupabaseTransactionalNamedExecutorGrantStore(
    {
      async getApprovedGrant() {
        lookupCalls += 1;
        return null;
      },
    },
    {
      async rpc(functionName, args) {
        consumeCalls.push({ functionName, args });
        return { data: true, error: null };
      },
    },
  );
  assert(await transactional.getApprovedGrant(
    { organizationId: "org-1", workspaceId: "workspace-1" },
    binding,
  ) === null && lookupCalls === 1, "Transactional store must delegate grant discovery to its dedicated lookup store.");
  assert(await transactional.consumeApprovedGrant(
    { organizationId: "org-1", workspaceId: "workspace-1" },
    "grant-1",
    binding,
    "2026-11-19T12:00:02.000Z",
  ), "A successful auth.uid()-bound consume RPC must return true.");
  const consumeCall = consumeCalls[0];
  assert(consumeCall?.functionName === "consume_file_mutation_approval_grant",
    "Transactional store called an unexpected consume RPC.");
  assert(consumeCall.args.p_grant_id === "grant-1" &&
    consumeCall.args.p_organization_id === "org-1" &&
    consumeCall.args.p_workspace_id === "workspace-1" &&
    consumeCall.args.p_request_id === "request-1" &&
    consumeCall.args.p_task_id === "task-1" &&
    consumeCall.args.p_mission_id === "mission-1" &&
    consumeCall.args.p_target_entity_id === "file-1" &&
    consumeCall.args.p_operation === "MODIFY" &&
    consumeCall.args.p_source_path === "docs/plan.md" &&
    consumeCall.args.p_destination_path === null &&
    consumeCall.args.p_input_digest === "a".repeat(64),
    "Consume RPC did not receive the complete immutable grant binding.");
  assert(!("p_executor_user_id" in consumeCall.args) &&
    !("p_requester_user_id" in consumeCall.args) &&
    !("p_approver_user_id" in consumeCall.args) &&
    !("p_consumed_at" in consumeCall.args),
    "Caller-supplied principals or timestamps must not be sent to the auth.uid()-bound consume RPC.");

  const deniedStore = new SupabaseTransactionalNamedExecutorGrantStore(
    { async getApprovedGrant() { return null; } },
    { async rpc() { return { data: false, error: null }; } },
  );
  assert(!(await deniedStore.consumeApprovedGrant(
    { organizationId: "org-1", workspaceId: "workspace-1" },
    "grant-1",
    binding,
    "2026-11-19T12:00:03.000Z",
  )), "A false RPC result must deny grant consumption.");

  const errorStore = new SupabaseTransactionalNamedExecutorGrantStore(
    { async getApprovedGrant() { return null; } },
    { async rpc() { return { data: true, error: { message: "permission denied" } }; } },
  );
  assert(!(await errorStore.consumeApprovedGrant(
    { organizationId: "org-1", workspaceId: "workspace-1" },
    "grant-1",
    binding,
    "2026-11-19T12:00:04.000Z",
  )), "RPC errors must fail closed.");

  const throwingStore = new SupabaseTransactionalNamedExecutorGrantStore(
    { async getApprovedGrant() { return null; } },
    { async rpc() { throw new Error("network unavailable"); } },
  );
  assert(!(await throwingStore.consumeApprovedGrant(
    { organizationId: "org-1", workspaceId: "workspace-1" },
    "grant-1",
    binding,
    "2026-11-19T12:00:05.000Z",
  )), "Thrown RPC failures must fail closed.");

  const lookupRpcCalls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
  const approvedGrantRow = {
    grant_id: "grant-1",
    request_id: "request-1",
    task_id: "task-1",
    mission_id: "mission-1",
    requester_user_id: "requester-1",
    executor_user_id: "executor-1",
    approver_user_id: "approver-1",
    organization_id: "org-1",
    workspace_id: "workspace-1",
    target_entity_type: "FILE",
    target_entity_id: "file-1",
    operation: "MODIFY",
    source_path: "docs/plan.md",
    destination_path: null,
    input_digest: "a".repeat(64),
    required_role: "ADMIN",
    status: "APPROVED",
    expires_at: "2026-12-01T00:00:00.000Z",
    consumed_at: null,
  };
  const lookupStore = new SupabaseAuthenticatedNamedExecutorGrantLookupStore({
    async rpc(functionName, args) {
      lookupRpcCalls.push({ functionName, args });
      return { data: [approvedGrantRow], error: null };
    },
  });
  const approvedGrant = await lookupStore.getApprovedGrant(
    { organizationId: "org-1", workspaceId: "workspace-1" },
    {
      requestId: "request-1",
      taskId: "task-1",
      missionId: "mission-1",
      requesterUserId: "requester-1",
      executorUserId: "executor-1",
      organizationId: "org-1",
      workspaceId: "workspace-1",
      targetEntityType: "FILE",
      targetEntityId: "file-1",
      operation: "MODIFY",
      sourcePath: "docs/plan.md",
      destinationPath: null,
      inputDigest: "a".repeat(64),
    },
  );
  assert(approvedGrant?.grantId === "grant-1" &&
    approvedGrant.approverUserId === "approver-1" &&
    approvedGrant.executorUserId === "executor-1" &&
    approvedGrant.requiredRole === "ADMIN",
    "Authenticated grant lookup did not map the exact approved grant.");
  const lookupCall = lookupRpcCalls[0];
  assert(lookupCall?.functionName === "resolve_authenticated_file_mutation_approval_grant",
    "Grant lookup did not use the executor-bound RPC.");
  assert(lookupCall.args.p_organization_id === "org-1" &&
    lookupCall.args.p_workspace_id === "workspace-1" &&
    lookupCall.args.p_request_id === "request-1" &&
    lookupCall.args.p_task_id === "task-1" &&
    lookupCall.args.p_mission_id === "mission-1" &&
    lookupCall.args.p_requester_user_id === "requester-1" &&
    lookupCall.args.p_target_entity_id === "file-1" &&
    lookupCall.args.p_operation === "MODIFY" &&
    lookupCall.args.p_source_path === "docs/plan.md" &&
    lookupCall.args.p_destination_path === null &&
    lookupCall.args.p_input_digest === "a".repeat(64),
    "Grant lookup RPC did not receive the full immutable binding.");
  assert(!("p_executor_user_id" in lookupCall.args) &&
    !("p_approver_user_id" in lookupCall.args),
    "Executor/approver identity must be database-derived or grant-derived, not caller supplied.");
  assert(!(await lookupStore.consumeApprovedGrant(
    { organizationId: "org-1", workspaceId: "workspace-1" },
    "grant-1",
    binding,
    "2026-11-19T12:00:06.000Z",
  )), "Read-only lookup adapter must not consume grants.");

  const mismatchedExecutorLookupStore = new SupabaseAuthenticatedNamedExecutorGrantLookupStore({
    async rpc() {
      return { data: [{ ...approvedGrantRow, executor_user_id: "different-executor" }], error: null };
    },
  });
  assert(await mismatchedExecutorLookupStore.getApprovedGrant(
    { organizationId: "org-1", workspaceId: "workspace-1" },
    {
      requestId: "request-1", taskId: "task-1", missionId: "mission-1",
      requesterUserId: "requester-1", executorUserId: "executor-1",
      organizationId: "org-1", workspaceId: "workspace-1",
      targetEntityType: "FILE", targetEntityId: "file-1",
      operation: "MODIFY", sourcePath: "docs/plan.md",
      destinationPath: null, inputDigest: "a".repeat(64),
    },
  ) === null, "Grant lookup must reject a row bound to a different executor.");

  const ambiguousLookupStore = new SupabaseAuthenticatedNamedExecutorGrantLookupStore({
    async rpc() { return { data: [approvedGrantRow, approvedGrantRow], error: null }; },
  });
  assert(await ambiguousLookupStore.getApprovedGrant(
    { organizationId: "org-1", workspaceId: "workspace-1" },
    {
      requestId: "request-1", taskId: "task-1", missionId: "mission-1",
      requesterUserId: "requester-1", executorUserId: "executor-1",
      organizationId: "org-1", workspaceId: "workspace-1",
      targetEntityType: "FILE", targetEntityId: "file-1",
      operation: "MODIFY", sourcePath: "docs/plan.md",
      destinationPath: null, inputDigest: "a".repeat(64),
    },
  ) === null, "Ambiguous multiple grant matches must fail closed.");

  const failedLookupStore = new SupabaseAuthenticatedNamedExecutorGrantLookupStore({
    async rpc() { return { data: null, error: { message: "permission denied" } }; },
  });
  assert(await failedLookupStore.getApprovedGrant(
    { organizationId: "org-1", workspaceId: "workspace-1" },
    {
      requestId: "request-1", taskId: "task-1", missionId: "mission-1",
      requesterUserId: "requester-1", executorUserId: "executor-1",
      organizationId: "org-1", workspaceId: "workspace-1",
      targetEntityType: "FILE", targetEntityId: "file-1",
      operation: "MODIFY", sourcePath: "docs/plan.md",
      destinationPath: null, inputDigest: "a".repeat(64),
    },
  ) === null, "Grant lookup RPC errors must fail closed.");

  console.log("Supabase private tenant/grant adapter contract: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
