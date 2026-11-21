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
  const captureState: { lookup: NamedExecutorGrantLookup | undefined } = { lookup: undefined };
  function currentGrant(): NamedExecutorGrant {
    if (!stored) throw new Error("Expected a persisted test grant.");
    return stored;
  }

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
    { async getActiveActor(userId, requested, grantId) {
      assert(grantId === "grant-1", "Approver membership lookup must be bound to the persisted grant ID.");
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
      captureState.lookup = lookup;
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
  if (!lookup) throw new Error("Expected canonical binding lookup.");
  stored = {
    ...lookup, grantId: "grant-1", approverUserId: "approver-B",
    requiredRole: "FOUNDER", status: "APPROVED",
    expiresAt: "2026-11-20T12:00:00.000Z",
  };

  assert(await authorizer.authorize(request, operation), "Distinct requester/approver/executor grant should authorize.");
  assert(consumed && currentGrant().status === "CONSUMED", "Grant was not consumed.");
  assert(captureState.lookup?.executorUserId === "executor-C", "Lookup did not bind the named executor.");
  assert(captureState.lookup?.requesterUserId === "requester-A", "Lookup did not bind the requester.");
  assert(currentGrant().approverUserId === "approver-B", "Persisted approver identity was not retained.");
  assert(!(await authorizer.authorize(request, operation)), "Consumed grant replay was accepted.");

  // The requester cannot approve their own FILE mutation, even with a valid role.
  stored = { ...currentGrant(), status: "APPROVED", consumedAt: undefined, approverUserId: "requester-A" };
  let selfApprovalMembershipLookups = 0;
  const selfApproval = new NamedExecutorFileMutationAuthorizer(
    { async getContext() { return context; } },
    store,
    { async getActiveActor(userId) {
      selfApprovalMembershipLookups += 1;
      return userId === "requester-A" ? { userId, organizationIds: [scope.organizationId], workspaceIds: [scope.workspaceId] } : null;
    } },
    { async hasRequiredRole() { return true; } },
    () => now,
  );
  const beforeSelfApproval = consumeCount;
  assert(!(await selfApproval.authorize(request, operation)), "Requester self-approval was accepted.");
  assert(selfApprovalMembershipLookups === 0, "Self-approval reached approver membership lookup.");
  assert(consumeCount === beforeSelfApproval, "Self-approval reached atomic consume.");
  stored = { ...currentGrant(), status: "APPROVED", consumedAt: undefined, approverUserId: "approver-B" };

  // Operation tampering must not reach the atomic consume step.
  stored = { ...currentGrant(), status: "APPROVED", consumedAt: undefined };
  const beforeTamper = consumeCount;
  assert(!(await authorizer.authorize(request, { ...operation, content: "tampered" })), "Changed content was accepted.");
  assert(consumeCount === beforeTamper, "Changed content reached atomic consume.");
  assert(!(await authorizer.authorize(request, { ...operation, path: "notes/other.txt" })), "Changed path was accepted.");
  assert(consumeCount === beforeTamper, "Changed path reached atomic consume.");

  // Concurrent callers race on the same one-time grant; exactly one wins.
  stored = { ...currentGrant(), status: "APPROVED", consumedAt: undefined };
  const concurrent = await Promise.all([
    authorizer.authorize(request, operation),
    authorizer.authorize(request, operation),
  ]);
  assert(concurrent.filter(Boolean).length === 1, "Concurrent grant consumption did not have exactly one winner.");

  // A grant for another named executor must be denied before consumption.
  stored = { ...currentGrant(), status: "APPROVED", consumedAt: undefined, executorUserId: "executor-D" };
  consumed = false;
  const beforeWrongExecutor = consumeCount;
  assert(!(await authorizer.authorize(request, operation)), "Wrong executor was accepted.");
  assert(consumeCount === beforeWrongExecutor, "Wrong executor reached atomic consume.");

  // Approver must independently be an active member and retain the role.
  stored = { ...currentGrant(), executorUserId: "executor-C", status: "APPROVED", consumedAt: undefined };
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
