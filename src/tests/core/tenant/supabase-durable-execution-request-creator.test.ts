import {
  SupabaseDurableExecutionRequestCreator,
  SupabaseExecutionRequestApprovalDecisionStore,
} from "../../../core/tenant/supabase-named-executor-context-provider";
import type {
  SupabaseExecutionRequestCreateRpcClient,
  SupabaseExecutionRequestDecisionRpcClient,
} from "../../../core/tenant/supabase-private-tenant-stores";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const command = {
    requestId: "request-1",
    taskId: "task-1",
    missionId: "mission-1",
    organizationId: "org-1",
    workspaceId: "workspace-1",
    capability: "API" as const,
    action: "POST",
    input: { value: 1 },
    idempotencyKey: "idempotency-1",
  };
  const calls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const client: SupabaseExecutionRequestCreateRpcClient = {
    async rpc(name, args) {
      calls.push({ name, args });
      return {
        error: null,
        data: [{
          request_id: "request-1",
          task_id: "task-1",
          mission_id: "mission-1",
          requester_user_id: "user-1",
          executor_user_id: "user-1",
          organization_id: "org-1",
          workspace_id: "workspace-1",
          capability: "API",
          action: "POST",
          input: { value: 1 },
          target_reference: null,
          risk: "HIGH",
          requires_approval: true,
          approval_status: "PENDING",
          required_approval_role: "FOUNDER",
          status: "WAITING_APPROVAL",
          input_digest: "a".repeat(64),
          envelope_digest: "b".repeat(64),
        }],
      };
    },
  };

  const created = await new SupabaseDurableExecutionRequestCreator(client).create(command);
  assert(created === "request-1", "A valid persisted immutable request envelope was not accepted.");
  assert(calls.length === 1 && calls[0].name === "create_authenticated_execution_request",
    "Request creation must use the authenticated database RPC.");
  assert(calls[0].args.p_target_reference === null,
    "An absent target reference must be sent as explicit SQL NULL, not omitted.");

  const mismatchedClient: SupabaseExecutionRequestCreateRpcClient = {
    async rpc() {
      return {
        error: null,
        data: [{
          request_id: "request-1", task_id: "task-1", mission_id: "mission-1",
          requester_user_id: "user-1", executor_user_id: "user-1",
          organization_id: "org-1", workspace_id: "workspace-1",
          capability: "API", action: "DELETE", input: { value: 1 },
          target_reference: null, risk: "HIGH", requires_approval: true,
          approval_status: "PENDING", required_approval_role: "FOUNDER",
          status: "WAITING_APPROVAL", input_digest: "a".repeat(64),
          envelope_digest: "b".repeat(64),
        }],
      };
    },
  };
  assert(await new SupabaseDurableExecutionRequestCreator(mismatchedClient).create(command) === null,
    "A database response with a different immutable action was accepted.");

  const decisionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const decisionClient: SupabaseExecutionRequestDecisionRpcClient = {
    async rpc(name, args) {
      decisionCalls.push({ name, args });
      return { error: null, data: true };
    },
  };
  assert(await new SupabaseExecutionRequestApprovalDecisionStore(decisionClient).decide(
    "request-1", "APPROVED", "founder reviewed",
  ), "A confirmed database approval decision was not returned.");
  assert(decisionCalls.length === 1 &&
    decisionCalls[0].name === "decide_authenticated_execution_request" &&
    decisionCalls[0].args.p_request_id === "request-1" &&
    decisionCalls[0].args.p_decision === "APPROVED" &&
    decisionCalls[0].args.p_reason === "founder reviewed",
    "Approval decision must send only request ID, decision and reason.");

  const deniedDecision: SupabaseExecutionRequestDecisionRpcClient = {
    async rpc() { return { error: null, data: false }; },
  };
  assert(!(await new SupabaseExecutionRequestApprovalDecisionStore(deniedDecision).decide(
    "request-1", "APPROVED", "founder reviewed",
  )), "A denied database decision must not be reported as approved.");

  console.log("Supabase durable execution request creator/decision adapter: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
