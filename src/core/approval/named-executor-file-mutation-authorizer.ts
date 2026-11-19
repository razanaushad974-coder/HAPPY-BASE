import { createHash } from "node:crypto";

import type { AuthenticatedApprovalActor, ApprovalRoleAuthorizer } from "./pipeline-approval-verifier";
import type { FileMutationAuthorizer } from "../execution/file-execution-adapter";
import type { ExecutionRequest } from "../execution/types";
import type { WorkspaceFileOperationRequest } from "../execution/workspace-code-executor";

export type NamedExecutorRole = "FOUNDER" | "ADMIN";
type Scope = { organizationId: string; workspaceId: string };

export interface NamedExecutorContext {
  /** Current server-validated session identity and canonical active tenant membership. */
  executor: AuthenticatedApprovalActor;
  /** Loaded from the durable server-owned execution request, never request JSON. */
  requesterUserId: string;
  organizationId: string;
  workspaceId: string;
}

export interface NamedExecutorContextProvider {
  getContext(request: ExecutionRequest): Promise<NamedExecutorContext | null>;
}

export interface PersistedApproverMembershipProvider {
  /** Independently loads current approver membership in the exact tenant. */
  getActiveActor(userId: string, scope: Scope): Promise<AuthenticatedApprovalActor | null>;
}

export interface NamedExecutorGrantLookup {
  requestId: string;
  taskId: string;
  missionId: string;
  requesterUserId: string;
  executorUserId: string;
  organizationId: string;
  workspaceId: string;
  targetEntityType: "FILE";
  targetEntityId: string;
  operation: WorkspaceFileOperationRequest["action"];
  sourcePath: string;
  destinationPath: string | null;
  inputDigest: string;
}

export interface NamedExecutorGrant extends NamedExecutorGrantLookup {
  grantId: string;
  approverUserId: string;
  requiredRole: NamedExecutorRole;
  status: "APPROVED" | "REVOKED" | "EXPIRED" | "CONSUMED";
  expiresAt: string;
  consumedAt?: string;
}

export interface NamedExecutorGrantBinding extends NamedExecutorGrantLookup {
  approverUserId: string;
}

export interface NamedExecutorGrantStore {
  /** Tenant-scoped candidate lookup. Must not filter approver by current executor. */
  getApprovedGrant(scope: Scope, lookup: NamedExecutorGrantLookup): Promise<NamedExecutorGrant | null>;
  /** One atomic conditional transition matching every immutable field, including approver and executor. */
  consumeApprovedGrant(scope: Scope, grantId: string, binding: NamedExecutorGrantBinding, consumedAt: string): Promise<boolean>;
}

function operationDigest(request: ExecutionRequest, operation: WorkspaceFileOperationRequest): string {
  const canonical = JSON.stringify({
    requestId: request.id,
    requestAction: request.action,
    taskId: request.taskId,
    missionId: request.missionId,
    capability: request.capability,
    action: operation.action,
    sourcePath: operation.path,
    destinationPath: operation.destinationPath ?? null,
    content: operation.content ?? null,
    expectedPreviousContentHash: operation.expectedPreviousContentHash ?? null,
    targetEntityType: request.targetReference?.entityType ?? null,
    targetEntityId: request.targetReference?.entityId ?? null,
  });
  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

function validActor(actor: AuthenticatedApprovalActor | null, userId: string, scope: Scope): actor is AuthenticatedApprovalActor {
  return !!actor &&
    actor.userId === userId &&
    actor.organizationIds.includes(scope.organizationId) &&
    actor.workspaceIds.includes(scope.workspaceId);
}

/**
 * Distinct-principal FILE grant verifier. It is deliberately separate from the
 * legacy same-actor verifier and is not wired into runtime composition here.
 * All providers/stores must be server-owned; failures deny authorization.
 */
export class NamedExecutorFileMutationAuthorizer implements FileMutationAuthorizer {
  constructor(
    private readonly contexts: NamedExecutorContextProvider,
    private readonly grants: NamedExecutorGrantStore,
    private readonly approvers: PersistedApproverMembershipProvider,
    private readonly roles: ApprovalRoleAuthorizer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async authorize(request: ExecutionRequest, operation: WorkspaceFileOperationRequest): Promise<boolean> {
    try {
      if (
        request.capability !== "FILE" ||
        request.action !== operation.action ||
        operation.action === "READ" ||
        !request.id.trim() ||
        !request.taskId.trim() ||
        !request.missionId.trim() ||
        request.targetReference?.entityType !== "FILE" ||
        !request.targetReference.entityId.trim()
      ) return false;

      const context = await this.contexts.getContext(request);
      if (!context) return false;
      const scope = { organizationId: context.organizationId, workspaceId: context.workspaceId };
      const executorId = context.executor?.userId?.trim();
      const requesterId = context.requesterUserId?.trim();
      if (!executorId || !requesterId || !scope.organizationId.trim() || !scope.workspaceId.trim() ||
          !validActor(context.executor, executorId, scope)) return false;

      const lookup: NamedExecutorGrantLookup = {
        requestId: request.id,
        taskId: request.taskId,
        missionId: request.missionId,
        requesterUserId: requesterId,
        executorUserId: executorId,
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        targetEntityType: "FILE",
        targetEntityId: request.targetReference.entityId,
        operation: operation.action,
        sourcePath: operation.path,
        destinationPath: operation.destinationPath ?? null,
        inputDigest: operationDigest(request, operation),
      };

      const grant = await this.grants.getApprovedGrant(scope, lookup);
      if (!grant || grant.status !== "APPROVED" || grant.consumedAt ||
          grant.executorUserId !== executorId ||
          grant.requesterUserId !== requesterId ||
          grant.requestId !== lookup.requestId ||
          grant.taskId !== lookup.taskId ||
          grant.missionId !== lookup.missionId ||
          grant.organizationId !== scope.organizationId ||
          grant.workspaceId !== scope.workspaceId ||
          grant.targetEntityType !== lookup.targetEntityType ||
          grant.targetEntityId !== lookup.targetEntityId ||
          grant.operation !== lookup.operation ||
          grant.sourcePath !== lookup.sourcePath ||
          grant.destinationPath !== lookup.destinationPath ||
          grant.inputDigest !== lookup.inputDigest ||
          !grant.approverUserId.trim() ||
          grant.approverUserId === requesterId) return false;

      const now = this.now();
      const expiry = Date.parse(grant.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= now.getTime()) return false;

      // Approver identity comes only from the persisted decision/grant and is
      // independently revalidated; it is never equated to the executor.
      const approver = await this.approvers.getActiveActor(grant.approverUserId, scope);
      if (!validActor(approver, grant.approverUserId, scope)) return false;
      if (!await this.roles.hasRequiredRole(approver, grant.requiredRole, scope)) return false;

      const binding: NamedExecutorGrantBinding = {
        ...lookup,
        approverUserId: grant.approverUserId,
      };
      return await this.grants.consumeApprovedGrant(scope, grant.grantId, binding, now.toISOString());
    } catch {
      return false;
    }
  }
}
