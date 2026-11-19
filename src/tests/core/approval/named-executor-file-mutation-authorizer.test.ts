import {
  NamedExecutorFileMutationAuthorizer,
  type NamedExecutorContext,
  type NamedExecutorGrant,
  type NamedExecutorGrantBinding,
  type NamedExecutorGrantLookup,
  type NamedExecutorGrantStore,
} from "../../../core/approval/named-executor-file-mutation-authorizer";
import type { ExecutionRequest } from "../../../core/execution/types";
import type { WorkspaceFileOperationRequest } from "../../../core/execution/workspace-code-executor";

function assert(value: boolean, message: string): void {
  if (!value) throw new Error(message);
}

async function main(): Promise<void> {
  const now = new Date("2026-11-19T12:00:00.000Z");
  const scope = { organizationId: "org-1", workspaceId: "workspace-1" };
  const request: ExecutionRequest = {
    id: "request-1", taskId: "task-1", missionId: "mission-1",
    capability: "FILE", action: "CREATE",
    input: { operation: "CREATE", path: "notes/a.txt", content: "approved" },
    targetReference: { token: "file", entityType: "FILE", entityId: "file-1", confidence: "HIGH", source: "ACTIVE_CONTEXT" },
    requiresApproval: true, approved: true, risk: "HIGH", createdAt: now.toISOString(),
  };
  const operation: WorkspaceFileOperationRequest = {
    action: "CREATE", path: "notes/a.txt", content: "approved",
  };
  // Three different principals: requester A, approver B, executor C.
  const context: NamedExecutorContext = {
    executor: { userId: "executor-C", organizationIds: [scope.organizationId], workspaceIds: [scope.workspaceId] },
    requesterUserId: "requester-A",
    ...scope,
  };
  const approver = { userId: "approver-B", organizationIds: [scope.organizationId], workspaceIds: [scope.workspaceId] };
  let stored: NamedExecutorGrant | null = null;
  let consumed = false;
  let consumeCount = 0;
  const captureState: { lookup?: NamedExecutorGrantLookup } = {};

  const store: NamedExecutorGrantStore = {
    async getApprovedGrant(_scope, lookup) {
      captureState.lookup = lookup;
      return stored ? { ...stored } : null;
    },
    async consumeApprovedGrant(_scope, grantId, binding, consumedAt) {
      consumeCount += 1;
      if (!stored || stored.grantId !== grantId || stored.status !== "APPROVED" || stored.consumedAt) return false;
      const keys = Object.keys(binding) as (keyof NamedExecutorGrantBinding)[];
      if (keys.some((key) => stored?.[key] !== binding[key])) return false;
      stored = { ...stored, status: "CONSUMED", consumedAt };
      consumed = true;
      return true;
    },
  };
  const authorizer = new NamedExecutorFileMutationAuthorizer(
    { async getContext() { return context; } },
    store,
    { async getActiveActor(userId, requested) {
      return userId === approver.userId && requested.organizationId === scope.organizationId &&
        requested.workspaceId === scope.workspaceId ? approver : null;
    } },
    { async hasRequiredRole(actor, role, requested) {
      return actor.userId === "approver-B" && role === "FOUNDER" &&
        requested.organizationId === scope.organizationId && requested.workspaceId === scope.workspaceId;
    } },
    () => now,
  );

  // First compute the canonical lookup without authorizing, then persist it as
  // an approved server-side grant. The approver is not the execution actor.
  const captureStore: NamedExecutorGrantStore = {
    async getApprovedGrant(_scope, lookup) {
      lookupSeen = lookup;
      return null;
    },
    async consumeApprovedGrant() { return false; },
  };
  const capture = new NamedExecutorFileMutationAuthorizer(
    { async getContext() { return context; } },
    captureStore,
    { async getActiveActor() { return approver; } },
    { async hasRequiredRole() { return true; } },
    () => now,
  );
  assert(!(await capture.authorize(request, operation)), "Lookup capture should not authorize without a persisted grant.");
  const lookup = captureState.lookup;
  assert(lookup !== undefined, "Expected canonical binding lookup.");
  stored = {
    ...lookup, grantId: "grant-1", approverUserId: "approver-B",
    requiredRole: "FOUNDER", status: "APPROVED",
    expiresAt: "2026-11-20T12:00:00.000Z",
  };

  assert(await authorizer.authorize(request, operation), "Distinct requester/approver/executor grant should authorize.");
  assert(consumed && stored.status === "CONSUMED", "Grant was not consumed.");
  assert(captureState.lookup?.executorUserId === "executor-C", "Lookup did not bind the named executor.");
  assert(captureState.lookup?.requesterUserId === "requester-A", "Lookup did not bind the requester.");
  assert(stored.approverUserId === "approver-B", "Persisted approver identity was not retained.");
  assert(!(await authorizer.authorize(request, operation)), "Consumed grant replay was accepted.");

  // A grant for another named executor must be denied before consumption.
  stored = { ...stored, status: "APPROVED", consumedAt: undefined, executorUserId: "executor-D" };
  consumed = false;
  const beforeWrongExecutor = consumeCount;
  assert(!(await authorizer.authorize(request, operation)), "Wrong executor was accepted.");
  assert(consumeCount === beforeWrongExecutor, "Wrong executor reached atomic consume.");

  // Approver must independently be an active member and retain the role.
  stored = { ...stored, executorUserId: "executor-C", status: "APPROVED", consumedAt: undefined };
  const missingApprover = new NamedExecutorFileMutationAuthorizer(
    { async getContext() { return context; } }, store,
    { async getActiveActor() { return null; } },
    { async hasRequiredRole() { return true; } }, () => now,
  );
  const beforeMissingApprover = consumeCount;
  assert(!(await missingApprover.authorize(request, operation)), "Inactive/missing approver was accepted.");
  assert(consumeCount === beforeMissingApprover, "Missing approver reached atomic consume.");

  const revokedRole = new NamedExecutorFileMutationAuthorizer(
    { async getContext() { return context; } }, store,
    { async getActiveActor() { return approver; } },
    { async hasRequiredRole() { return false; } }, () => now,
  );
  assert(!(await revokedRole.authorize(request, operation)), "Approver with revoked role was accepted.");

  const wrongTenantContext = new NamedExecutorFileMutationAuthorizer(
    { async getContext() { return { ...context, executor: { ...context.executor, workspaceIds: [] } }; } },
    store,
    { async getActiveActor() { return approver; } },
    { async hasRequiredRole() { return true; } }, () => now,
  );
  assert(!(await wrongTenantContext.authorize(request, operation)), "Executor without tenant membership was accepted.");

  const failingStore = new NamedExecutorFileMutationAuthorizer(
    { async getContext() { return context; } },
    { async getApprovedGrant() { throw new Error("store unavailable"); }, async consumeApprovedGrant() { return false; } },
    { async getActiveActor() { return approver; } },
    { async hasRequiredRole() { return true; } }, () => now,
  );
  assert(!(await failingStore.authorize(request, operation)), "Grant store failure did not fail closed.");

  console.log("PASS: distinct requester/approver/executor, named executor, approver membership/role, tenant isolation, replay and fail-closed store.");
}

void main();
