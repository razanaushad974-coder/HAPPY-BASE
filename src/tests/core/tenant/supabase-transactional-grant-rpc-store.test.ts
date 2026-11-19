import {
  SupabaseTransactionalNamedExecutorGrantStore,
  type VerifiedExecutorUserScopedRpcClient,
} from "../../../core/tenant/supabase-private-tenant-stores";
import type {
  NamedExecutorGrantBinding,
  NamedExecutorGrantStore,
} from "../../../core/approval/named-executor-file-mutation-authorizer";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  let response: { data: unknown; error: { message?: string } | null } = {
    data: true,
    error: null,
  };
  const rpcClient: VerifiedExecutorUserScopedRpcClient = {
    async rpc(name, args) {
      calls.push({ name, args });
      return response;
    },
  };
  const lookupStore = {
    async getApprovedGrant() {
      return null;
    },
  } as unknown as Pick<NamedExecutorGrantStore, "getApprovedGrant">;

  const store = new SupabaseTransactionalNamedExecutorGrantStore(lookupStore, rpcClient);
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

  const accepted = await store.consumeApprovedGrant(
    { organizationId: "org-1", workspaceId: "workspace-1" },
    "grant-1",
    binding,
    "2026-11-19T12:00:00.000Z",
  );
  assert(accepted, "The transactional RPC true result was not accepted.");
  assert(calls.length === 1, "Expected exactly one RPC invocation.");
  assert(calls[0].name === "consume_file_mutation_approval_grant", "Unexpected RPC function.");
  for (const [key, value] of Object.entries({
    p_grant_id: "grant-1",
    p_organization_id: "org-1",
    p_workspace_id: "workspace-1",
    p_request_id: "request-1",
    p_task_id: "task-1",
    p_mission_id: "mission-1",
    p_target_entity_id: "file-1",
    p_operation: "MODIFY",
    p_source_path: "docs/plan.md",
    p_destination_path: null,
    p_input_digest: "a".repeat(64),
  })) {
    assert(calls[0].args[key] === value, `Missing or incorrect RPC argument: ${key}`);
  }
  for (const forbidden of [
    "p_requester_user_id",
    "p_executor_user_id",
    "p_approver_user_id",
    "p_consumed_at",
  ]) {
    assert(!(forbidden in calls[0].args), `Untrusted principal/time argument was sent: ${forbidden}`);
  }

  response = { data: false, error: null };
  assert(!(await store.consumeApprovedGrant(
    { organizationId: "org-1", workspaceId: "workspace-1" },
    "grant-1",
    binding,
    "2026-11-19T12:00:01.000Z",
  )), "A database denial must remain denied.");

  response = { data: true, error: { message: "RPC failure" } };
  assert(!(await store.consumeApprovedGrant(
    { organizationId: "org-1", workspaceId: "workspace-1" },
    "grant-1",
    binding,
    "2026-11-19T12:00:02.000Z",
  )), "An RPC error must fail closed.");

  console.log("Supabase transactional grant RPC adapter contract: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
