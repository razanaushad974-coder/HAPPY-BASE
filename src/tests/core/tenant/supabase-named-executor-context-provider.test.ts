import {
  SupabaseNamedExecutorContextProvider,
  SupabasePersistedApproverMembershipProvider,
  SupabaseMembershipApprovalRoleAuthorizer,
  SupabaseDurableExecutionRequestStore,
  type DurableExecutionRequestStore,
  type VerifiedServerIdentityProvider,
} from "../../../core/tenant/supabase-named-executor-context-provider";
import type {
  CanonicalTenantMembershipStore,
  OrganizationMembershipRecord,
  WorkspaceMembershipRecord,
} from "../../../core/tenant/canonical-tenant-context";
import type { ExecutionRequest } from "../../../core/execution/types";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const org: OrganizationMembershipRecord = {
    userId: "executor-1", organizationId: "org-1", status: "ACTIVE", role: "MEMBER",
  };
  const workspace: WorkspaceMembershipRecord = {
    userId: "executor-1", organizationId: "org-1", workspaceId: "workspace-1",
    status: "ACTIVE", role: "MEMBER",
  };
  const memberships: CanonicalTenantMembershipStore = {
    async getTenantMembershipPair(userId, organizationId, workspaceId) {
      return userId === org.userId &&
        organizationId === org.organizationId &&
        workspaceId === workspace.workspaceId
        ? { organization: org, workspace }
        : null;
    },
  };
  const identity: VerifiedServerIdentityProvider = {
    async getVerifiedIdentity() { return { userId: "executor-1" }; },
  };
  const durable: DurableExecutionRequestStore = {
    async getByRequestId(requestId) {
      return requestId === "request-1" ? {
        requestId, taskId: "task-1", missionId: "mission-1",
        requesterUserId: "requester-1", executorUserId: "executor-1",
        organizationId: "org-1", workspaceId: "workspace-1",
        executionRequest: {
          id: requestId, taskId: "task-1", missionId: "mission-1",
          capability: "FILE", action: "MODIFY", input: {},
          requiresApproval: true, approved: false, risk: "HIGH",
          createdAt: "2026-11-19T00:00:00.000Z",
        },
        status: "WAITING_APPROVAL", approvalStatus: "PENDING",
        requiredApprovalRole: "FOUNDER", inputDigest: "a".repeat(64),
      } : null;
    },
  };
  const request = {
    id: "request-1", taskId: "task-1", missionId: "mission-1",
    capability: "FILE", action: "MODIFY", input: {}, requiresApproval: true,
    approved: false, risk: "HIGH", createdAt: "2026-11-19T00:00:00.000Z",
  } as ExecutionRequest;

  const rpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const rpcStore = new SupabaseDurableExecutionRequestStore({
    async rpc(name, args) {
      rpcCalls.push({ name, args });
      return {
        error: null,
        data: [{
          request_id: "request-1", task_id: "task-1", mission_id: "mission-1",
          requester_user_id: "requester-1", executor_user_id: "executor-1",
          organization_id: "org-1", workspace_id: "workspace-1",
          capability: "FILE", action: "MODIFY", input: {},
          target_reference: null, requires_approval: true, risk: "HIGH",
          approval_status: "PENDING", required_approval_role: "FOUNDER",
          status: "WAITING_APPROVAL", input_digest: "a".repeat(64),
          created_at: "2026-11-19T00:00:00.000Z",
        }],
      };
    },
  });
  const loadedRequest = await rpcStore.getByRequestId("request-1");
  assert(loadedRequest?.requesterUserId === "requester-1",
    "Durable request principals must be loaded from the executor-bound RPC.");
  assert(rpcCalls.length === 1 &&
    rpcCalls[0].name === "resolve_authenticated_execution_request" &&
    rpcCalls[0].args.p_request_id === "request-1" &&
    Object.keys(rpcCalls[0].args).length === 1,
    "Request lookup must send only the opaque request ID; auth.uid() supplies executor identity.");

  const deniedRequestStore = new SupabaseDurableExecutionRequestStore({
    async rpc() { return { error: null, data: [] }; },
  });
  assert(await deniedRequestStore.getByRequestId("request-1") === null,
    "A request not assigned to auth.uid() must be unavailable.");
  const erroredRequestStore = new SupabaseDurableExecutionRequestStore({
    async rpc() { return { error: { message: "denied" }, data: null }; },
  });
  assert(await erroredRequestStore.getByRequestId("request-1") === null,
    "RPC errors must fail closed.");

  const contexts = new SupabaseNamedExecutorContextProvider(identity, durable, memberships);
  const context = await contexts.getContext(request);
  assert(context?.requesterUserId === "requester-1", "Requester must come from durable request.");
  assert(context.executor.userId === "executor-1", "Executor must come from verified session.");
  assert(context.organizationId === "org-1" && context.workspaceId === "workspace-1",
    "Tenant scope must come from durable request plus active membership.");

  const wrongIdentity: VerifiedServerIdentityProvider = {
    async getVerifiedIdentity() { return { userId: "attacker-1" }; },
  };
  const denied = await new SupabaseNamedExecutorContextProvider(
    wrongIdentity, durable, memberships,
  ).getContext(request);
  assert(denied === null, "Session identity different from named executor must be denied.");

  const approverRpcCalls: Array<{ name: string; args: Record<string, unknown> }> = [];
  const approvers = new SupabasePersistedApproverMembershipProvider({
    async rpc(name, args) {
      approverRpcCalls.push({ name, args });
      return {
        error: null,
        data: [{
          approver_user_id: "approver-1",
          organization_id: "org-1",
          workspace_id: "workspace-1",
          organization_role: "FOUNDER",
          workspace_role: "ADMIN",
        }],
      };
    },
  });
  const approver = await approvers.getActiveActor("approver-1", {
    organizationId: "org-1", workspaceId: "workspace-1",
  }, "grant-1");
  assert(approver?.userId === "approver-1", "Persisted approver identity was not resolved.");
  assert(approver.organizationRole === "FOUNDER" && approver.workspaceRole === "ADMIN",
    "Current approver role evidence was not mapped.");
  assert(approverRpcCalls.length === 1 &&
    approverRpcCalls[0].name === "resolve_authenticated_file_mutation_approver_membership" &&
    approverRpcCalls[0].args.p_grant_id === "grant-1" &&
    approverRpcCalls[0].args.p_organization_id === "org-1" &&
    approverRpcCalls[0].args.p_workspace_id === "workspace-1" &&
    Object.keys(approverRpcCalls[0].args).length === 3,
    "Approver lookup must send only persisted grant and tenant selectors; auth.uid() supplies executor.");

  const mismatchedApprover = new SupabasePersistedApproverMembershipProvider({
    async rpc() {
      return { error: null, data: [{
        approver_user_id: "different-user",
        organization_id: "org-1",
        workspace_id: "workspace-1",
        organization_role: "FOUNDER",
        workspace_role: "ADMIN",
      }] };
    },
  });
  assert(await mismatchedApprover.getActiveActor("approver-1", {
    organizationId: "org-1", workspaceId: "workspace-1",
  }, "grant-1") === null, "RPC result for a different persisted approver was accepted.");

  const revokedApprover = new SupabasePersistedApproverMembershipProvider({
    async rpc() { return { error: null, data: [] }; },
  });
  assert(await revokedApprover.getActiveActor("approver-1", {
    organizationId: "org-1", workspaceId: "workspace-1",
  }, "grant-1") === null, "Revoked/missing approver membership must deny.");

  const erroredApprover = new SupabasePersistedApproverMembershipProvider({
    async rpc() { return { error: { message: "denied" }, data: null }; },
  });
  assert(await erroredApprover.getActiveActor("approver-1", {
    organizationId: "org-1", workspaceId: "workspace-1",
  }, "grant-1") === null, "Approver RPC error must fail closed.");

  let crossUserMembershipReads = 0;
  const roleAuthorizer = new SupabaseMembershipApprovalRoleAuthorizer(
    {
      async getTenantMembershipPair() {
        crossUserMembershipReads += 1;
        return null;
      },
    },
    (organizationRole, workspaceRole, requiredRole) =>
      requiredRole === "FOUNDER" && organizationRole === "FOUNDER" &&
      workspaceRole === "ADMIN",
  );
  assert(await roleAuthorizer.hasRequiredRole(approver, "FOUNDER", {
    organizationId: "org-1", workspaceId: "workspace-1",
  }), "Explicit role policy should authorize RPC-verified approver role evidence.");
  assert(!(await roleAuthorizer.hasRequiredRole(approver, "ADMIN", {
    organizationId: "org-1", workspaceId: "workspace-1",
  })), "Role policy must not infer ADMIN from FOUNDER.");
  assert(crossUserMembershipReads === 0,
    "Role authorization must not re-query auth.uid()-bound membership as the distinct approver.");

  console.log("Supabase named-executor context and approver providers: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
