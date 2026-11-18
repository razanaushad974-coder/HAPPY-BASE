import {
  PersistedFileMutationAuthorizer,
  type FileMutationAuthorizationContext,
  type FileMutationGrantBinding,
  type PersistedFileMutationGrant,
  type PersistedFileMutationGrantStore,
} from "../../../core/approval/file-mutation-approval-authorizer";
import type { ExecutionRequest } from "../../../core/execution/types";
import type { WorkspaceFileOperationRequest } from "../../../core/execution/workspace-code-executor";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function expectDenied(
  authorizer: PersistedFileMutationAuthorizer,
  request: ExecutionRequest,
  operation: WorkspaceFileOperationRequest,
  message: string,
): Promise<void> {
  assert(!(await authorizer.authorize(request, operation)), message);
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
  const context: FileMutationAuthorizationContext = {
    actor: {
      userId: "founder-1",
      organizationIds: ["org-1"],
      workspaceIds: ["workspace-1"],
    },
    requesterUserId: "requester-1",
    organizationId: "org-1",
    workspaceId: "workspace-1",
  };

  // Capture the canonical binding produced by the verifier, then persist that
  // exact binding in the fake grant. The fake store never manufactures a
  // digest during lookup, so content/path/target mutations cannot be masked.
  let persistedBinding!: FileMutationGrantBinding;
  const seedGrant: PersistedFileMutationGrant = {
    grantId: "grant-1",
    requestId: request.id,
    taskId: request.taskId,
    missionId: request.missionId,
    requesterUserId: context.requesterUserId,
    approverUserId: context.actor.userId,
    organizationId: context.organizationId,
    workspaceId: context.workspaceId,
    targetEntityType: "FILE",
    targetEntityId: "file-1",
    operation: "CREATE",
    sourcePath: operation.path,
    destinationPath: null,
    inputDigest: "seed",
    requiredRole: "FOUNDER",
    status: "APPROVED",
    expiresAt: "2026-11-19T12:00:00.000Z",
  };
  const captureAuthorizer = new PersistedFileMutationAuthorizer(
    { async getContext() { return context; } },
    {
      async getApprovedGrant(_scope, binding) {
        persistedBinding = binding;
        return { ...seedGrant, ...binding };
      },
      async consumeApprovedGrant() { return true; },
    },
    { async hasRequiredRole() { return true; } },
    () => now,
  );
  assert(
    await captureAuthorizer.authorize(request, operation),
    "Canonical binding capture failed.",
  );
  const approvedGrant: PersistedFileMutationGrant = {
    ...seedGrant,
    ...persistedBinding,
    inputDigest: persistedBinding.inputDigest,
  };

  function makeHarness(options: {
    grant?: PersistedFileMutationGrant;
    context?: FileMutationAuthorizationContext | null;
    roleAllowed?: boolean;
    failLookup?: boolean;
    failConsume?: boolean;
  } = {}) {
    let grant = { ...(options.grant ?? approvedGrant) };
    let consumed = false;
    let consumeAttempts = 0;
    const store: PersistedFileMutationGrantStore = {
      async getApprovedGrant(scope, _binding) {
        if (options.failLookup) throw new Error("lookup unavailable");
        if (
          scope.organizationId !== "org-1" ||
          scope.workspaceId !== "workspace-1"
        ) return null;
        return { ...grant };
      },
      async consumeApprovedGrant(scope, grantId, binding, consumedAt) {
        consumeAttempts += 1;
        if (options.failConsume) throw new Error("consume unavailable");
        if (
          scope.organizationId !== grant.organizationId ||
          scope.workspaceId !== grant.workspaceId ||
          grantId !== grant.grantId ||
          grant.status !== "APPROVED" ||
          grant.consumedAt ||
          Date.parse(grant.expiresAt) <= Date.parse(consumedAt)
        ) return false;
        const keys: (keyof FileMutationGrantBinding)[] = [
          "requestId", "taskId", "missionId", "requesterUserId",
          "approverUserId", "organizationId", "workspaceId",
          "targetEntityType", "targetEntityId", "operation",
          "sourcePath", "destinationPath", "inputDigest",
        ];
        if (keys.some((key) => grant[key] !== binding[key])) return false;
        // Synchronous state transition models the store's atomic conditional
        // UPDATE: only one concurrent caller can change APPROVED to CONSUMED.
        consumed = true;
        grant = { ...grant, status: "CONSUMED", consumedAt };
        return true;
      },
    };
    const authorizer = new PersistedFileMutationAuthorizer(
      { async getContext() { return options.context === undefined ? context : options.context; } },
      store,
      { async hasRequiredRole() { return options.roleAllowed ?? true; } },
      () => now,
    );
    return {
      authorizer,
      getGrant: () => grant,
      isConsumed: () => consumed,
      getConsumeAttempts: () => consumeAttempts,
    };
  }

  // A valid exact grant is consumed once; a replay is denied.
  const success = makeHarness();
  assert(await success.authorizer.authorize(request, operation), "Valid exact grant was rejected.");
  assert(success.isConsumed(), "Successful authorization did not consume the grant.");
  await expectDenied(success.authorizer, request, operation, "Consumed grant replay was accepted.");

  // Expiry, revocation, current-role loss, and tenant/requester/approver
  // mismatches must all fail closed before consumption.
  const expired = makeHarness({
    grant: { ...approvedGrant, expiresAt: "2026-11-18T11:59:59.000Z" },
  });
  await expectDenied(expired.authorizer, request, operation, "Expired grant was accepted.");

  const revoked = makeHarness({
    grant: { ...approvedGrant, status: "REVOKED" },
  });
  await expectDenied(revoked.authorizer, request, operation, "Revoked grant was accepted.");

  const roleRevoked = makeHarness({ roleAllowed: false });
  await expectDenied(roleRevoked.authorizer, request, operation, "Actor without the current approver role was accepted.");

  const wrongRequester = makeHarness({
    context: { ...context, requesterUserId: "different-requester" },
  });
  await expectDenied(wrongRequester.authorizer, request, operation, "Mismatched requester was accepted.");

  const wrongApprover = makeHarness({
    context: {
      ...context,
      actor: {
        ...context.actor,
        userId: "different-approver",
      },
    },
  });
  await expectDenied(wrongApprover.authorizer, request, operation, "Mismatched approver was accepted.");

  const actorOutsideWorkspace = makeHarness({
    context: {
      ...context,
      actor: { ...context.actor, workspaceIds: [] },
    },
  });
  await expectDenied(actorOutsideWorkspace.authorizer, request, operation, "Actor without workspace membership was accepted.");

  const actorOutsideOrganization = makeHarness({
    context: {
      ...context,
      actor: { ...context.actor, organizationIds: [] },
    },
  });
  await expectDenied(
    actorOutsideOrganization.authorizer,
    request,
    operation,
    "Actor without organization membership was accepted.",
  );

  const readRequest: ExecutionRequest = { ...request, action: "READ" };
  await expectDenied(
    makeHarness().authorizer,
    readRequest,
    { ...operation, action: "READ" },
    "READ was incorrectly accepted as a mutation grant.",
  );

  const wrongTenant = makeHarness({
    context: { ...context, workspaceId: "other-workspace" },
  });
  await expectDenied(wrongTenant.authorizer, request, operation, "Mismatched tenant was accepted.");

  // The orchestration action must agree with the extracted FILE operation.
  await expectDenied(
    makeHarness().authorizer,
    { ...request, action: "MODIFY" },
    operation,
    "Mismatched orchestration action was accepted.",
  );

  // Every operation-defining field is bound to the approval.
  await expectDenied(
    makeHarness().authorizer,
    request,
    { ...operation, content: "tampered content" },
    "Changed file content reused the old grant.",
  );
  await expectDenied(
    makeHarness().authorizer,
    request,
    { ...operation, path: "notes/other.txt" },
    "Changed source path reused the old grant.",
  );
  await expectDenied(
    makeHarness().authorizer,
    request,
    { ...operation, action: "MODIFY" },
    "Changed operation reused the old grant.",
  );
  await expectDenied(
    makeHarness().authorizer,
    {
      ...request,
      targetReference: { ...request.targetReference!, entityId: "file-2" },
    },
    operation,
    "Changed target entity reused the old grant.",
  );
  await expectDenied(
    makeHarness().authorizer,
    { ...request, taskId: "task-2" },
    operation,
    "Changed task reused the old grant.",
  );
  await expectDenied(
    makeHarness().authorizer,
    { ...request, missionId: "mission-2" },
    operation,
    "Changed mission reused the old grant.",
  );

  const copyOperation: WorkspaceFileOperationRequest = {
    action: "COPY",
    path: "notes/source.txt",
    destinationPath: "archive/source.txt",
  };
  const copyRequest: ExecutionRequest = {
    ...request,
    action: "COPY",
    input: {
      operation: "COPY",
      path: copyOperation.path,
      destinationPath: copyOperation.destinationPath,
    },
  };
  let copyBinding!: FileMutationGrantBinding;
  const copyCapture = new PersistedFileMutationAuthorizer(
    { async getContext() { return context; } },
    {
      async getApprovedGrant(_scope, binding) {
        copyBinding = binding;
        return { ...approvedGrant, ...binding };
      },
      async consumeApprovedGrant() { return true; },
    },
    { async hasRequiredRole() { return true; } },
    () => now,
  );
  assert(
    await copyCapture.authorize(copyRequest, copyOperation),
    "Valid COPY grant binding was rejected.",
  );
  const copyGrantBinding: PersistedFileMutationGrant = {
    ...approvedGrant,
    ...copyBinding,
  };
  const copyHarness = makeHarness({
    grant: copyGrantBinding,
  });
  await expectDenied(
    copyHarness.authorizer,
    copyRequest,
    { ...copyOperation, destinationPath: "archive/other.txt" },
    "Changed destination path reused the old grant.",
  );

  const lookupFailure = makeHarness({ failLookup: true });
  await expectDenied(lookupFailure.authorizer, request, operation, "Grant lookup outage did not fail closed.");

  const consumeFailure = makeHarness({ failConsume: true });
  await expectDenied(consumeFailure.authorizer, request, operation, "Atomic consume outage did not fail closed.");

  // Concurrent attempts against one grant must yield exactly one success.
  const concurrent = makeHarness();
  const results = await Promise.all([
    concurrent.authorizer.authorize(request, operation),
    concurrent.authorizer.authorize(request, operation),
  ]);
  assert(results.filter(Boolean).length === 1, "Concurrent grant consumption was not single-use.");
  assert(concurrent.isConsumed(), "Concurrent success did not persist consumption.");
  assert(concurrent.getConsumeAttempts() === 2, "Expected both concurrent calls to reach atomic consume.");

  console.log("Persisted file mutation grant contract: PASS (expiry, revocation, exact binding, role, tenant, replay, concurrency, fail-closed)");
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
