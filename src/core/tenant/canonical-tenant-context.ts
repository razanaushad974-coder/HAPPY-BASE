import type { AuthenticatedApprovalActor } from "../approval/pipeline-approval-verifier";

export interface VerifiedTenantIdentity {
  /** Supabase-verified JWT subject, obtained only by a server-side auth provider. */
  userId: string;
}

export interface RequestedTenantScope {
  /** Selection only; never proof of membership. */
  organizationId: string;
  /** Selection only; never proof of membership. */
  workspaceId: string;
}

export interface OrganizationMembershipRecord {
  userId: string;
  organizationId: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  role: string;
}

export interface WorkspaceMembershipRecord {
  userId: string;
  organizationId: string;
  workspaceId: string;
  status: "ACTIVE" | "SUSPENDED" | "REVOKED";
  role: string;
}

/**
 * Implementations must query the authoritative membership tables using the
 * verified user ID and exact requested scope. Do not implement with JWT
 * user_metadata, request-body role arrays, or client-provided membership.
 */
export interface CanonicalTenantMembershipStore {
  getOrganizationMembership(
    userId: string,
    organizationId: string,
  ): Promise<OrganizationMembershipRecord | null>;

  getWorkspaceMembership(
    userId: string,
    organizationId: string,
    workspaceId: string,
  ): Promise<WorkspaceMembershipRecord | null>;
}

export interface CanonicalTenantContext {
  actor: AuthenticatedApprovalActor;
  organizationId: string;
  workspaceId: string;
  organizationRole: string;
  workspaceRole: string;
}

/**
 * Resolve one canonical tenant scope from a verified server identity and
 * authoritative membership records. Any missing, inactive, or mismatched
 * record fails closed. This is a core contract; it does not itself provide a
 * Supabase store or authenticate a request.
 */
export async function resolveCanonicalTenantContext(
  identity: VerifiedTenantIdentity | null,
  requestedScope: RequestedTenantScope,
  memberships: CanonicalTenantMembershipStore,
): Promise<CanonicalTenantContext | null> {
  const userId = identity?.userId?.trim();
  const organizationId = requestedScope.organizationId?.trim();
  const workspaceId = requestedScope.workspaceId?.trim();

  if (!userId || !organizationId || !workspaceId) return null;

  try {
    const organization = await memberships.getOrganizationMembership(
      userId,
      organizationId,
    );
    if (
      !organization ||
      organization.userId !== userId ||
      organization.organizationId !== organizationId ||
      organization.status !== "ACTIVE" ||
      !organization.role.trim()
    ) {
      return null;
    }

    const workspace = await memberships.getWorkspaceMembership(
      userId,
      organizationId,
      workspaceId,
    );
    if (
      !workspace ||
      workspace.userId !== userId ||
      workspace.organizationId !== organizationId ||
      workspace.workspaceId !== workspaceId ||
      workspace.status !== "ACTIVE" ||
      !workspace.role.trim()
    ) {
      return null;
    }

    const actor: AuthenticatedApprovalActor = {
      userId,
      organizationIds: [organizationId],
      workspaceIds: [workspaceId],
    };

    return {
      actor,
      organizationId,
      workspaceId,
      organizationRole: organization.role,
      workspaceRole: workspace.role,
    };
  } catch {
    // Membership lookup errors are authorization failures, never fallbacks.
    return null;
  }
}
