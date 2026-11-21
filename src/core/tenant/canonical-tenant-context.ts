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
 * Implementations must resolve the exact scope against authoritative membership
 * records and bind the result to the verified user. Database RPCs should derive
 * the principal from auth.uid(); never pass a caller-selected user ID as authority.
 */
export interface CanonicalTenantMembershipPair {
  organization: OrganizationMembershipRecord;
  workspace: WorkspaceMembershipRecord;
}

export interface CanonicalTenantMembershipStore {
  /** One authoritative, user-bound lookup for the exact organization/workspace pair. */
  getTenantMembershipPair(
    userId: string,
    organizationId: string,
    workspaceId: string,
  ): Promise<CanonicalTenantMembershipPair | null>;
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
    const pair = await memberships.getTenantMembershipPair(
      userId,
      organizationId,
      workspaceId,
    );
    const organization = pair?.organization;
    const workspace = pair?.workspace;
    if (
      !organization ||
      organization.userId !== userId ||
      organization.organizationId !== organizationId ||
      organization.status !== "ACTIVE" ||
      !organization.role.trim() ||
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


/**
 * Server-session boundary used by route composition. The requested tenant
 * scope is only a selector; actor identity is always loaded from the trusted
 * server identity provider and membership is resolved before any state access.
 */
export interface VerifiedServerIdentityProvider {
  getVerifiedIdentity(): Promise<VerifiedTenantIdentity | null>;
}

export type AuthenticatedTenantResolution =
  | { status: "AUTHENTICATED"; context: CanonicalTenantContext }
  | { status: "UNAUTHENTICATED" | "TENANT_ACCESS_DENIED" };

/**
 * Fail-closed composition helper for server routes. It deliberately accepts
 * no user ID from the request and never falls back to caller-provided identity.
 */
export async function resolveAuthenticatedTenantContext(
  identities: VerifiedServerIdentityProvider,
  requestedScope: RequestedTenantScope,
  memberships: CanonicalTenantMembershipStore,
): Promise<AuthenticatedTenantResolution> {
  let identity: VerifiedTenantIdentity | null;
  try {
    identity = await identities.getVerifiedIdentity();
  } catch {
    return { status: "UNAUTHENTICATED" };
  }

  if (!identity?.userId?.trim()) {
    return { status: "UNAUTHENTICATED" };
  }

  const context = await resolveCanonicalTenantContext(
    identity,
    requestedScope,
    memberships,
  );

  return context
    ? { status: "AUTHENTICATED", context }
    : { status: "TENANT_ACCESS_DENIED" };
}
