import type {
  PipelineApprovalVerificationContext,
  PipelineApprovalVerifier,
} from "../orchestration/types";

export type PipelineApprovalRole = "FOUNDER" | "ADMIN";

export interface AuthenticatedApprovalActor {
  userId: string;
  organizationIds: string[];
  workspaceIds: string[];
}

export interface PersistedPipelineApproval {
  requestId: string;
  planId: string;
  organizationId: string;
  workspaceId: string;
  requesterUserId: string;
  approverUserId: string;
  requiredRole: PipelineApprovalRole;
  status: "PENDING" | "APPROVED" | "REJECTED" | "EXPIRED" | "CANCELLED";
  expiresAt: string;
  decidedAt?: string;
}

export interface ApprovalSessionProvider {
  /** Must read the server-validated session; never derive this from request JSON. */
  getAuthenticatedActor(): Promise<AuthenticatedApprovalActor | null>;
}

export interface PersistedPipelineApprovalStore {
  /** Must load from the durable, tenant-scoped source of truth. */
  getByRequestId(
    scope: { organizationId: string; workspaceId: string },
    requestId: string,
  ): Promise<PersistedPipelineApproval | null>;
}

export interface ApprovalRoleAuthorizer {
  hasRequiredRole(
    actor: AuthenticatedApprovalActor,
    role: PipelineApprovalRole,
    scope: { organizationId: string; workspaceId: string },
  ): Promise<boolean>;
}

/**
 * Concrete fail-closed verifier. The application must supply a real session
 * provider, durable approval store, and role authorizer. No caller-provided
 * identity or approval boolean is accepted as proof.
 */
export class PersistedPipelineApprovalVerifier
implements PipelineApprovalVerifier {
  constructor(
    private readonly sessions: ApprovalSessionProvider,
    private readonly approvals: PersistedPipelineApprovalStore,
    private readonly roles: ApprovalRoleAuthorizer,
    private readonly now: () => Date = () => new Date(),
  ) {}

  async verifyPersistedApproval(
    context: PipelineApprovalVerificationContext,
  ): Promise<boolean> {
    try {
      const actor = await this.sessions.getAuthenticatedActor();
      if (
        !actor ||
        !actor.userId.trim() ||
        actor.userId !== context.authenticatedActorUserId ||
        !actor.organizationIds.includes(context.organizationId) ||
        !actor.workspaceIds.includes(context.workspaceId)
      ) {
        return false;
      }

      const approval = await this.approvals.getByRequestId(
        {
          organizationId: context.organizationId,
          workspaceId: context.workspaceId,
        },
        context.requestId,
      );

      if (
        !approval ||
        approval.status !== "APPROVED" ||
        approval.requestId !== context.requestId ||
        approval.planId !== context.planId ||
        approval.organizationId !== context.organizationId ||
        approval.workspaceId !== context.workspaceId ||
        approval.requesterUserId !== context.requesterUserId ||
        approval.approverUserId !== actor.userId ||
        !approval.decidedAt
      ) {
        return false;
      }

      const expiry = Date.parse(approval.expiresAt);
      const decidedAt = Date.parse(approval.decidedAt);
      const now = this.now().getTime();

      if (
        !Number.isFinite(expiry) ||
        !Number.isFinite(decidedAt) ||
        expiry <= now ||
        decidedAt > now ||
        decidedAt > expiry
      ) {
        return false;
      }

      return await this.roles.hasRequiredRole(
        actor,
        approval.requiredRole,
        {
          organizationId: context.organizationId,
          workspaceId: context.workspaceId,
        },
      );
    } catch {
      // Any session, storage, or authorization failure must fail closed.
      return false;
    }
  }
}
