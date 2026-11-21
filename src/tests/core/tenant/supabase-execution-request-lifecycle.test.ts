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
    capability: "FILE" as const,
    action: "MODIFY",
    input: { path: "docs/plan.md", content: "approved content" },
    idempotencyKey: "idem-1",
  };
  const createCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const createClient: SupabaseExecutionRequestCreateRpcClient = {
    async rpc(name, args) {
      createCalls.push({ name, args });
      return {
        error: null,
        data: [{
          request_id: command.requestId,
          task_id: command.taskId,
          mission_id: command.missionId,
          requester_user_id: "user-1",
          executor_user_id: "user-1",
          organization_id: command.organizationId,
          workspace_id: command.workspaceId,
          capability: command.capability,
          action: command.action,
          input: command.input,
          target_reference: null,
          risk: "HIGH",
          requires_approval: true,
          approval_status: "PENDING",
          required_approval_role: "FOUNDER",
          status: "WAITING_APPROVAL",
          idempotency_key: command.idempotencyKey,
          input_digest: String(args.p_input_digest),
        }],
      };
    },
  };
  const createdRequestId = await new SupabaseDurableExecutionRequestCreator(createClient).create(command);
  assert(createdRequestId === command.requestId,
    "A complete server-bound, founder-gated envelope should return its persisted request ID.");
  assert(createCalls.length === 1 &&
    createCalls[0].name === "create_authenticated_execution_request" &&
    typeof createCalls[0].args.p_input_digest === "string" &&
    /^[0-9a-f]{64}$/.test(createCalls[0].args.p_input_digest as string) &&
    createCalls[0].args.p_organization_id === command.organizationId &&
    createCalls[0].args.p_workspace_id === command.workspaceId &&
    !("p_requester_user_id" in createCalls[0].args) &&
    !("p_executor_user_id" in createCalls[0].args) &&
    !("p_risk" in createCalls[0].args) &&
    !("p_approval_status" in createCalls[0].args),
    "Caller must not select principals, risk, or approval state.");
  const deniedCreate = new SupabaseDurableExecutionRequestCreator({
    async rpc() { return { error: { message: "tenant denied" }, data: null }; },
  });
  assert((await deniedCreate.create(command)) === null, "Create RPC failure must fail closed.");
  const malformedCreate = new SupabaseDurableExecutionRequestCreator({
    async rpc() {
      return { error: null, data: [{ status: "READY" }] };
    },
  });
  assert((await malformedCreate.create(command)) === null, "A malformed durable response must be rejected.");

  const decisionCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const decisionClient: SupabaseExecutionRequestDecisionRpcClient = {
    async rpc(name, args) {
      decisionCalls.push({ name, args });
      return { error: null, data: true };
    },
  };
  assert(await new SupabaseExecutionRequestApprovalDecisionStore(decisionClient)
    .decide("request-1", "APPROVED", "Reviewed evidence and approved."),
    "Successful atomic decision RPC should be acknowledged.");
  assert(decisionCalls.length === 1 &&
    decisionCalls[0].name === "decide_authenticated_execution_request" &&
    decisionCalls[0].args.p_request_id === "request-1" &&
    decisionCalls[0].args.p_decision === "APPROVED" &&
    Object.keys(decisionCalls[0].args).length === 3,
    "Approval decision must send only request selector, decision, and reason; identity comes from auth.uid().");
  const deniedDecision = new SupabaseExecutionRequestApprovalDecisionStore({
    async rpc() { return { error: { message: "not founder" }, data: null }; },
  });
  assert(!(await deniedDecision.decide("request-1", "APPROVED", "approve")),
    "Decision RPC failure must fail closed.");
  assert(!(await new SupabaseExecutionRequestApprovalDecisionStore(decisionClient)
    .decide("request-1", "APPROVED", " ")),
    "Empty decision reasons must be rejected before RPC.");

  console.log("Supabase durable execution request lifecycle adapters: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
