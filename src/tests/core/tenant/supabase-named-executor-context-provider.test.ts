import {
  SupabaseNamedExecutorContextProvider,
  SupabasePersistedApproverMembershipProvider,
  SupabaseMembershipApprovalRoleAuthorizer,
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
      } : null;
    },
  };
  const request = {
    id: "request-1", taskId: "task-1", missionId: "mission-1",
    capability: "FILE", action: "MODIFY", input: {}, requiresApproval: true,
    approved: false, risk: "HIGH", createdAt: "2026-11-19T00:00:00.000Z",
  } as ExecutionRequest;

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

  const approverMemberships: CanonicalTenantMembershipStore = {
    async getTenantMembershipPair(userId, organizationId, workspaceId) {
      return userId === "approver-1" && organizationId === "org-1" &&
        workspaceId === "workspace-1"
        ? {
            organization: { userId, organizationId, status: "ACTIVE", role: "FOUNDER" },
            workspace: { userId, organizationId, workspaceId, status: "ACTIVE", role: "ADMIN" },
          }
        : null;
    },
  };
  const approvers = new SupabasePersistedApproverMembershipProvider(approverMemberships);
  const approver = await approvers.getActiveActor("approver-1", {
    organizationId: "org-1", workspaceId: "workspace-1",
  });
  assert(approver?.userId === "approver-1", "Persisted approver active membership was not resolved.");
  assert(await approvers.getActiveActor("removed-approver", {
    organizationId: "org-1", workspaceId: "workspace-1",
  }) === null, "Missing approver membership must deny.");

  const roleAuthorizer = new SupabaseMembershipApprovalRoleAuthorizer(
    approverMemberships,
    (organizationRole, workspaceRole, requiredRole) =>
      requiredRole === "FOUNDER" && organizationRole === "FOUNDER" &&
      workspaceRole === "ADMIN",
  );
  assert(await roleAuthorizer.hasRequiredRole(approver, "FOUNDER", {
    organizationId: "org-1", workspaceId: "workspace-1",
  }), "Explicit current membership role policy should authorize.");
  assert(!(await roleAuthorizer.hasRequiredRole(approver, "ADMIN", {
    organizationId: "org-1", workspaceId: "workspace-1",
  })), "Role policy must not infer ADMIN from FOUNDER.");

  console.log("Supabase named-executor context and approver providers: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
