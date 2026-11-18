import {
  PersistedFileMutationAuthorizer,
  type PersistedFileMutationGrant,
  type FileMutationGrantBinding,
} from "../../../core/approval/file-mutation-approval-authorizer";
import type { ExecutionRequest } from "../../../core/execution/types";
import type { WorkspaceFileOperationRequest } from "../../../core/execution/workspace-code-executor";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const now = new Date("2026-11-18T12:00:00.000Z");
  const request: ExecutionRequest = {
    id: "request-1",
    taskId: "task-1",
    missionId: "mission-1",
    capability: "FILE",
    action: "CREATE",
    input: {
      operation: "CREATE",
      path: "notes/approved.txt",
      content: "approved content",
    },
    targetReference: {
      token: "file",
      entityType: "FILE",
      entityId: "file-1",
      confidence: "HIGH",
      source: "ACTIVE_CONTEXT",
    },
    requiresApproval: true,
    approved: true,
    risk: "HIGH",
    createdAt: now.toISOString(),
  };
  const operation: WorkspaceFileOperationRequest = {
    action: "CREATE",
    path: "notes/approved.txt",
    content: "approved content",
  };
  const binding: FileMutationGrantBinding = {
    requestId: request.id,
    taskId: request.taskId,
    missionId: request.missionId,
    requesterUserId: "requester-1",
    approverUserId: "founder-1",
    organizationId: "org-1",
    workspaceId: "workspace-1",
    targetEntityType: "FILE",
    targetEntityId: "file-1",
    operation: "CREATE",
    sourcePath: "notes/approved.txt",
    destinationPath: null,
    inputDigest: "",
  };

  let grant: PersistedFileMutationGrant = {
    grantId: "grant-1",
    ...binding,
    inputDigest: "",
    requiredRole: "FOUNDER",
    status: "APPROVED",
    expiresAt: "2026-11-19T12:00:00.000Z",
  };
  let consumed = false;
  let roleAllowed = true;
  let tenantAllowed = true;

  const context = {
    actor: {
      userId: "founder-1",
      organizationIds: ["org-1"],
      workspaceIds: ["workspace-1"],
    },
    requesterUserId: "requester-1",
    organizationId: "org-1",
    workspaceId: "workspace-1",
  };

  // First pass computes the same digest through the public authorization path.
  const authorizer = new PersistedFileMutationAuthorizer(
    {
      async getContext() {
        return tenantAllowed ? context : {
          ...context,
          workspaceId: "other-workspace",
        };
      },
    },
    {
      async getApprovedGrant(scope, expected) {
        assert(scope.organizationId === "org-1", "Grant lookup lost organization scope.");
        assert(scope.workspaceId === "workspace-1", "Grant lookup lost workspace scope.");
        return grant.inputDigest === expected.inputDigest
          ? grant
          : { ...grant, inputDigest: expected.inputDigest };
      },
      async consumeApprovedGrant(_scope, grantId, expected, consumedAt) {
        if (
          consumed ||
          grantId !== grant.grantId ||
          grant.status !== "APPROVED" ||
          Date.parse(grant.expiresAt) <= Date.parse(consumedAt) ||
          grant.inputDigest !== expected.inputDigest
        ) return false;
        consumed = true;
        grant = { ...grant, status: "CONSUMED", consumedAt };
        return true;
      },
    },
    {
      async hasRequiredRole() {
        return roleAllowed;
      },
    },
    () => now,
  );

  // Seed the exact digest using the same canonical fields via an initial
  // lookup capture, then prove one successful consume and replay rejection.
  let observedBinding: FileMutationGrantBinding | null = null;
  const capturingAuthorizer = new PersistedFileMutationAuthorizer(
    { async getContext() { return context; } },
    {
      async getApprovedGrant(_scope, expected) {
        observedBinding = expected;
        return { ...grant, ...expected, inputDigest: expected.inputDigest };
      },
      async consumeApprovedGrant(_scope, _id, _expected) {
        return true;
      },
    },
    { async hasRequiredRole() { return true; } },
    () => now,
  );
  assert(await capturingAuthorizer.authorize(request, operation), "Exact grant binding should authorize.");
  assert(observedBinding !== null, "Authorizer did not derive a binding.");
  grant = {
    ...grant,
    ...(observedBinding as FileMutationGrantBinding),
    inputDigest: (observedBinding as FileMutationGrantBinding).inputDigest,
  };

  assert(await authorizer.authorize(request, operation), "Valid persisted grant was rejected.");
  assert(!(await authorizer.authorize(request, operation)), "Consumed grant replay was accepted.");

  consumed = false;
  grant = { ...grant, status: "APPROVED", consumedAt: undefined };
  roleAllowed = false;
  assert(!(await authorizer.authorize(request, operation)), "Actor without current approver role was accepted.");

  roleAllowed = true;
  tenantAllowed = false;
  assert(!(await authorizer.authorize(request, operation)), "Mismatched tenant context was accepted.");

  const alteredOperation: WorkspaceFileOperationRequest = {
    ...operation,
    content: "tampered content",
  };
  tenantAllowed = true;
  assert(!(await authorizer.authorize(request, alteredOperation)), "Changed file content reused the old grant.");

  const brokenStoreAuthorizer = new PersistedFileMutationAuthorizer(
    { async getContext() { return context; } },
    {
      async getApprovedGrant() { throw new Error("store unavailable"); },
      async consumeApprovedGrant() { return false; },
    },
    { async hasRequiredRole() { return true; } },
    () => now,
  );
  assert(!(await brokenStoreAuthorizer.authorize(request, operation)), "Store outage did not fail closed.");

  console.log("Persisted file mutation grant contract: PASS");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
