import {
  PersistedPipelineApprovalVerifier,
  type AuthenticatedApprovalActor,
  type PersistedPipelineApproval,
} from "../../core/approval/pipeline-approval-verifier";
import type { PipelineApprovalVerificationContext } from "../../core/orchestration/types";

const now = new Date("2026-11-07T12:00:00.000Z");
const context: PipelineApprovalVerificationContext = {
  requestId: "request-1",
  planId: "plan-1",
  organizationId: "org-1",
  workspaceId: "workspace-1",
  requesterUserId: "requester-1",
  authenticatedActorUserId: "founder-1",
};
const actor: AuthenticatedApprovalActor = {
  userId: "founder-1",
  organizationIds: ["org-1"],
  workspaceIds: ["workspace-1"],
};
const approval: PersistedPipelineApproval = {
  requestId: "request-1",
  planId: "plan-1",
  organizationId: "org-1",
  workspaceId: "workspace-1",
  requesterUserId: "requester-1",
  approverUserId: "founder-1",
  requiredRole: "FOUNDER",
  status: "APPROVED",
  expiresAt: "2026-11-08T12:00:00.000Z",
  decidedAt: "2026-11-07T11:00:00.000Z",
};

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  let stored: PersistedPipelineApproval | null = approval;
  let session: AuthenticatedApprovalActor | null = actor;
  let roleAllowed = true;

  const verifier = new PersistedPipelineApprovalVerifier(
    { async getAuthenticatedActor() { return session; } },
    {
      async getByRequestId(scope, requestId) {
        assert(scope.organizationId === context.organizationId, "Approval lookup lost organization scope.");
        assert(scope.workspaceId === context.workspaceId, "Approval lookup lost workspace scope.");
        assert(requestId === context.requestId, "Approval lookup used the wrong request ID.");
        return stored;
      },
    },
    { async hasRequiredRole() { return roleAllowed; } },
    () => now,
  );

  assert(await verifier.verifyPersistedApproval(context), "Valid persisted founder approval was rejected.");

  stored = { ...approval, planId: "different-plan" };
  assert(!(await verifier.verifyPersistedApproval(context)), "Mismatched plan approval was accepted.");

  stored = { ...approval, expiresAt: "2026-11-07T11:59:59.000Z" };
  assert(!(await verifier.verifyPersistedApproval(context)), "Expired approval was accepted.");

  stored = { ...approval, approverUserId: "someone-else" };
  assert(!(await verifier.verifyPersistedApproval(context)), "Approval from a different actor was accepted.");

  stored = approval;
  roleAllowed = false;
  assert(!(await verifier.verifyPersistedApproval(context)), "Actor without required role was accepted.");

  roleAllowed = true;
  session = null;
  assert(!(await verifier.verifyPersistedApproval(context)), "Missing authenticated session was accepted.");

  session = { ...actor, workspaceIds: ["other-workspace"] };
  assert(!(await verifier.verifyPersistedApproval(context)), "Actor outside workspace scope was accepted.");

  console.log("Persisted pipeline approval verifier contract: PASS");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
