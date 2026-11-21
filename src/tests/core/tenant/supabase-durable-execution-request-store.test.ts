import {
  SupabaseDurableExecutionRequestStore,
} from "../../../core/tenant/supabase-named-executor-context-provider";
import type {
  SupabaseExecutionRequestRpcClient,
} from "../../../core/tenant/supabase-private-tenant-stores";

async function main(): Promise<void> {
  const row = {
    request_id: "req-1", task_id: "task-1", mission_id: "mission-1",
    requester_user_id: "requester-1", executor_user_id: "executor-1",
    organization_id: "org-1", workspace_id: "workspace-1",
    capability: "FILE", action: "READ", input: { path: "README.md" },
    target_reference: null, requires_approval: true, risk: "HIGH",
    approval_status: "PENDING", required_approval_role: "FOUNDER", status: "WAITING_APPROVAL",
    input_digest: "a".repeat(64), envelope_digest: "b".repeat(64), created_at: "2026-11-21T12:00:00.000Z",
  };
  const calls: Array<{ name: string; args: { p_request_id: string } }> = [];
  const client: SupabaseExecutionRequestRpcClient = {
    async rpc(name, args) {
      calls.push({ name, args });
      return { data: [row], error: null };
    },
  };
  const store = new SupabaseDurableExecutionRequestStore(client);
  const record = await store.getByRequestId("req-1");
  if (!record || record.requesterUserId !== "requester-1" ||
      record.executorUserId !== "executor-1" ||
      record.executionRequest.capability !== "FILE" ||
      record.executionRequest.action !== "READ" ||
      (record.executionRequest.input as { path?: string }).path !== "README.md" ||
      record.executionRequest.requiresApproval !== true ||
      record.approvalStatus !== "PENDING" ||
      record.requiredApprovalRole !== "FOUNDER" ||
      record.status !== "WAITING_APPROVAL" ||
      record.inputDigest !== "a".repeat(64) ||
      record.envelopeDigest !== "b".repeat(64) ||
      calls.length !== 1 ||
      calls[0].name !== "resolve_authenticated_execution_request" ||
      calls[0].args.p_request_id !== "req-1") {
    throw new Error("Durable request must resolve through executor-bound RPC and map exact principals.");
  }

  const deniedClient: SupabaseExecutionRequestRpcClient = {
    async rpc() { return { data: [], error: null }; },
  };
  if (await new SupabaseDurableExecutionRequestStore(deniedClient).getByRequestId("foreign-request") !== null) {
    throw new Error("A request not assigned to auth.uid() must fail closed.");
  }

  const malformedClient: SupabaseExecutionRequestRpcClient = {
    async rpc() { return { data: [{ ...row, executor_user_id: null }], error: null }; },
  };
  if (await new SupabaseDurableExecutionRequestStore(malformedClient).getByRequestId("req-1") !== null) {
    throw new Error("Incomplete durable request rows must fail closed.");
  }

  const erroredClient: SupabaseExecutionRequestRpcClient = {
    async rpc() { return { data: null, error: { message: "denied" } }; },
  };
  if (await new SupabaseDurableExecutionRequestStore(erroredClient).getByRequestId("req-1") !== null) {
    throw new Error("RPC failures must fail closed.");
  }
  console.log("Supabase durable execution request store: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
