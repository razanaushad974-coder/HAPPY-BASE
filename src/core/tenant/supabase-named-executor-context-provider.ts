import type {
  NamedExecutorContext,
  NamedExecutorContextProvider,
  PersistedApproverMembershipProvider,
} from "../approval/named-executor-file-mutation-authorizer";
import type {
  ApprovalRoleAuthorizer,
  AuthenticatedApprovalActor,
} from "../approval/pipeline-approval-verifier";
import type { ExecutionRequest } from "../execution/types";
import {
  resolveCanonicalTenantContext,
  type CanonicalTenantMembershipStore,
} from "./canonical-tenant-context";
import type {
  SupabasePrivateSchemaClient,
} from "./supabase-private-tenant-stores";

export interface VerifiedServerIdentityProvider {
  /** Must call the server-side Supabase auth claims/session verifier. */
  getVerifiedIdentity(): Promise<{ userId: string } | null>;
}

export interface DurableExecutionRequestRecord {
  requestId: string;
  taskId: string;
  missionId: string;
  requesterUserId: string;
  executorUserId: string;
  organizationId: string;
  workspaceId: string;
}

export interface DurableExecutionRequestStore {
  getByRequestId(requestId: string): Promise<DurableExecutionRequestRecord | null>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredString(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.trim() ? value : null;
}

/** Reads immutable request principals from the private, server-owned table. */
export class SupabaseDurableExecutionRequestStore implements DurableExecutionRequestStore {
  constructor(private readonly client: SupabasePrivateSchemaClient) {}

  async getByRequestId(requestId: string): Promise<DurableExecutionRequestRecord | null> {
    try {
      const result = await this.client.schema("private")
        .from("execution_requests")
        .select("request_id,task_id,mission_id,requester_user_id,executor_user_id,organization_id,workspace_id")
        .eq("request_id", requestId)
        .maybeSingle();
      if (result.error || !isRecord(result.data)) return null;
      const row = result.data;
      const request = requiredString(row, "request_id");
      const task = requiredString(row, "task_id");
      const mission = requiredString(row, "mission_id");
      const requester = requiredString(row, "requester_user_id");
      const executor = requiredString(row, "executor_user_id");
      const organization = requiredString(row, "organization_id");
      const workspace = requiredString(row, "workspace_id");
      if (!request || !task || !mission || !requester || !executor || !organization || !workspace) {
        return null;
      }
      return {
        requestId: request,
        taskId: task,
        missionId: mission,
        requesterUserId: requester,
        executorUserId: executor,
        organizationId: organization,
        workspaceId: workspace,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Resolves the current executor from verified session claims and requester
 * identity from a durable request row. Runtime request fields are only checked
 * for consistency; they are never treated as principal or tenant authority.
 */
export class SupabaseNamedExecutorContextProvider implements NamedExecutorContextProvider {
  constructor(
    private readonly identities: VerifiedServerIdentityProvider,
    private readonly requests: DurableExecutionRequestStore,
    private readonly memberships: CanonicalTenantMembershipStore,
  ) {}

  async getContext(request: ExecutionRequest): Promise<NamedExecutorContext | null> {
    try {
      if (!request.id.trim() || !request.taskId.trim() || !request.missionId.trim()) return null;
      const identity = await this.identities.getVerifiedIdentity();
      if (!identity?.userId?.trim()) return null;
      const durable = await this.requests.getByRequestId(request.id);
      if (!durable ||
          durable.requestId !== request.id ||
          durable.taskId !== request.taskId ||
          durable.missionId !== request.missionId ||
          durable.executorUserId !== identity.userId) return null;

      const tenant = await resolveCanonicalTenantContext(
        identity,
        {
          organizationId: durable.organizationId,
          workspaceId: durable.workspaceId,
        },
        this.memberships,
      );
      if (!tenant || tenant.actor.userId !== durable.executorUserId) return null;
      return {
        executor: tenant.actor,
        requesterUserId: durable.requesterUserId,
        organizationId: tenant.organizationId,
        workspaceId: tenant.workspaceId,
      };
    } catch {
      return null;
    }
  }
}

/**
 * Role authorization deliberately requires an explicit project role policy.
 * The adapter re-reads both current membership rows at authorization time;
 * it does not infer role hierarchy or trust role strings from the JWT.
 */
/** Resolves the persisted approver from current active tenant membership. */
export class SupabasePersistedApproverMembershipProvider implements PersistedApproverMembershipProvider {
  constructor(private readonly memberships: CanonicalTenantMembershipStore) {}

  async getActiveActor(
    userId: string,
    scope: { organizationId: string; workspaceId: string },
  ): Promise<AuthenticatedApprovalActor | null> {
    try {
      const context = await resolveCanonicalTenantContext(
        { userId },
        scope,
        this.memberships,
      );
      return context?.actor ?? null;
    } catch {
      return null;
    }
  }
}

export type ApprovalMembershipRolePolicy = (
  organizationRole: string,
  workspaceRole: string,
  requiredRole: "FOUNDER" | "ADMIN",
) => boolean;

export class SupabaseMembershipApprovalRoleAuthorizer implements ApprovalRoleAuthorizer {
  constructor(
    private readonly memberships: CanonicalTenantMembershipStore,
    private readonly rolePolicy: ApprovalMembershipRolePolicy,
  ) {}

  async hasRequiredRole(
    actor: AuthenticatedApprovalActor,
    role: "FOUNDER" | "ADMIN",
    scope: { organizationId: string; workspaceId: string },
  ): Promise<boolean> {
    try {
      if (!actor.userId.trim() ||
          !actor.organizationIds.includes(scope.organizationId) ||
          !actor.workspaceIds.includes(scope.workspaceId)) return false;
      const organization = await this.memberships.getOrganizationMembership(
        actor.userId,
        scope.organizationId,
      );
      const workspace = await this.memberships.getWorkspaceMembership(
        actor.userId,
        scope.organizationId,
        scope.workspaceId,
      );
      if (!organization || !workspace ||
          organization.status !== "ACTIVE" || workspace.status !== "ACTIVE" ||
          organization.userId !== actor.userId || workspace.userId !== actor.userId ||
          organization.organizationId !== scope.organizationId ||
          workspace.organizationId !== scope.organizationId ||
          workspace.workspaceId !== scope.workspaceId) return false;
      return this.rolePolicy(organization.role, workspace.role, role) === true;
    } catch {
      return false;
    }
  }
}
