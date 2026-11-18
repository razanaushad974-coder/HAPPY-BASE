import { createHash } from "node:crypto";

import type {
  AuthenticatedApprovalActor,
  ApprovalRoleAuthorizer,
} from "./pipeline-approval-verifier";
import type {
  FileMutationAuthorizer,
} from "../execution/file-execution-adapter";
import type {
  ExecutionRequest,
} from "../execution/types";
import type {
  WorkspaceFileOperationRequest,
} from "../execution/workspace-code-executor";

export type FileMutationApprovalRole = "FOUNDER" | "ADMIN" | "SECURITY";

export interface FileMutationAuthorizationContext {
  /** Must be derived from the validated server session and trusted tenant resolver. */
  actor: AuthenticatedApprovalActor;
  requesterUserId: string;
  organizationId: string;
  workspaceId: string;
}

export interface FileMutationAuthorizationContextProvider {
  getContext(
    request: ExecutionRequest,
  ): Promise<FileMutationAuthorizationContext | null>;
}

export interface PersistedFileMutationGrant {
  grantId: string;
  requestId: string;
  taskId: string;
  missionId: string;
  requesterUserId: string;
  approverUserId: string;
  organizationId: string;
  workspaceId: string;
  targetEntityType: "FILE";
  targetEntityId: string;
  operation: WorkspaceFileOperationRequest["action"];
  sourcePath: string;
  destinationPath: string | null;
  inputDigest: string;
  requiredRole: FileMutationApprovalRole;
  status: "APPROVED" | "REVOKED" | "EXPIRED" | "CONSUMED";
  expiresAt: string;
  consumedAt?: string;
}

export interface FileMutationGrantBinding {
  requestId: string;
  taskId: string;
  missionId: string;
  requesterUserId: string;
  approverUserId: string;
  organizationId: string;
  workspaceId: string;
  targetEntityType: "FILE";
  targetEntityId: string;
  operation: WorkspaceFileOperationRequest["action"];
  sourcePath: string;
  destinationPath: string | null;
  inputDigest: string;
}

export interface PersistedFileMutationGrantStore {
  /** Tenant-scoped lookup. Must never return a grant from another tenant. */
  getApprovedGrant(
    scope: { organizationId: string; workspaceId: string },
    binding: FileMutationGrantBinding,
  ): Promise<PersistedFileMutationGrant | null>;

  /**
   * Must be one atomic conditional UPDATE/transaction:
   * status=APPROVED, expires_at > consumedAt, consumed_at IS NULL,
   * exact tenant + grant id + every binding field match.
   * Set status=CONSUMED and consumed_at in the same transaction.
   * Return false for replay, races, expiry, revocation, or any mismatch.
   */
  consumeApprovedGrant(
    scope: { organizationId: string; workspaceId: string },
    grantId: string,
    binding: FileMutationGrantBinding,
    consumedAt: string,
  ): Promise<boolean>;
}

function digestOperation(
  request: ExecutionRequest,
  operation: WorkspaceFileOperationRequest,
): string {
  // Fixed-key serialization prevents property-order ambiguity. Content is
  // included verbatim in the digest; it is never copied into grant metadata.
  const canonical = JSON.stringify({
    requestId: request.id,
    taskId: request.taskId,
    missionId: request.missionId,
    capability: request.capability,
    action: operation.action,
    sourcePath: operation.path,
    destinationPath: operation.destinationPath ?? null,
    content: operation.content ?? null,
    expectedPreviousContentHash:
      operation.expectedPreviousContentHash ?? null,
    targetEntityType: request.targetReference?.entityType ?? null,
    targetEntityId: request.targetReference?.entityId ?? null,
  });

  return createHash("sha256").update(canonical, "utf8").digest("hex");
}

/**
 * Fail-closed, one-time FILE mutation grant verifier.
 *
 * This is a production-boundary service, not a database adapter. The app must
 * supply a real server-session context provider, tenant-scoped durable store,
 * and live role authorizer from its authenticated server composition root.
 * Never instantiate it with request-body identity or an in-memory store.
 */
export class PersistedFileMutationAuthorizer
implements FileMutationAuthorizer {
  constructor(
    private readonly contexts: FileMutationAuthorizationContextProvider,
    private readonly grants: PersistedFileMutationGrantStore,
    private readonly roles: ApprovalRoleAuthorizer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async authorize(
    request: ExecutionRequest,
    operation: WorkspaceFileOperationRequest,
  ): Promise<boolean> {
    try {
      if (
        request.capability !== "FILE" ||
        operation.action === "READ" ||
        !request.id.trim() ||
        !request.taskId.trim() ||
        !request.missionId.trim() ||
        request.targetReference?.entityType !== "FILE" ||
        !request.targetReference.entityId.trim()
      ) {
        return false;
      }

      const context = await this.contexts.getContext(request);
      const actor = context?.actor;
      if (
        !context ||
        !actor?.userId?.trim() ||
        !context.requesterUserId.trim() ||
        !context.organizationId.trim() ||
        !context.workspaceId.trim() ||
        !actor.organizationIds.includes(context.organizationId) ||
        !actor.workspaceIds.includes(context.workspaceId)
      ) {
        return false;
      }

      const binding: FileMutationGrantBinding = {
        requestId: request.id,
        taskId: request.taskId,
        missionId: request.missionId,
        requesterUserId: context.requesterUserId,
        approverUserId: actor.userId,
        organizationId: context.organizationId,
        workspaceId: context.workspaceId,
        targetEntityType: "FILE",
        targetEntityId: request.targetReference.entityId,
        operation: operation.action,
        sourcePath: operation.path,
        destinationPath: operation.destinationPath ?? null,
        inputDigest: digestOperation(request, operation),
      };
      const scope = {
        organizationId: context.organizationId,
        workspaceId: context.workspaceId,
      };

      const grant = await this.grants.getApprovedGrant(scope, binding);
      if (
        !grant ||
        grant.status !== "APPROVED" ||
        grant.approverUserId !== actor.userId ||
        grant.requestId !== binding.requestId ||
        grant.taskId !== binding.taskId ||
        grant.missionId !== binding.missionId ||
        grant.requesterUserId !== binding.requesterUserId ||
        grant.organizationId !== binding.organizationId ||
        grant.workspaceId !== binding.workspaceId ||
        grant.targetEntityType !== binding.targetEntityType ||
        grant.targetEntityId !== binding.targetEntityId ||
        grant.operation !== binding.operation ||
        grant.sourcePath !== binding.sourcePath ||
        grant.destinationPath !== binding.destinationPath ||
        grant.inputDigest !== binding.inputDigest ||
        grant.consumedAt
      ) {
        return false;
      }

      const now = this.now();
      const expiry = Date.parse(grant.expiresAt);
      if (!Number.isFinite(expiry) || expiry <= now.getTime()) {
        return false;
      }

      const roleAllowed = await this.roles.hasRequiredRole(
        actor,
        grant.requiredRole,
        scope,
      );
      if (!roleAllowed) return false;

      // The durable store must atomically consume this exact grant. A
      // concurrent call or replay can therefore succeed at most once.
      return await this.grants.consumeApprovedGrant(
        scope,
        grant.grantId,
        binding,
        now.toISOString(),
      );
    } catch {
      return false;
    }
  }
}
