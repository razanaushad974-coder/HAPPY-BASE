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
  SupabaseApproverMembershipRpcClient,
  SupabaseExecutionRequestRpcClient,
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

/** Reads immutable request principals only through the executor-bound auth.uid() RPC. */
export class SupabaseDurableExecutionRequestStore implements DurableExecutionRequestStore {
  constructor(private readonly client: SupabaseExecutionRequestRpcClient) {}

  async getByRequestId(requestId: string): Promise<DurableExecutionRequestRecord | null> {
    try {
      if (!requestId.trim()) return null;
      const result = await this.client.rpc("resolve_authenticated_execution_request", {
        p_request_id: requestId,
      });
      if (result.error) return null;
      const rows = Array.isArray(result.data)
        ? result.data
        : result.data === null || result.data === undefined ? [] : [result.data];
      if (rows.length !== 1 || !isRecord(rows[0])) return null;
      const row = rows[0];
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
/**
 * Resolves the persisted approver from an executor-JWT-bound RPC. The caller
 * supplies only grant and tenant selectors; PostgreSQL derives executor via
 * auth.uid() and obtains approver identity from the immutable persisted grant.
 */
export class SupabasePersistedApproverMembershipProvider implements PersistedApproverMembershipProvider {
  constructor(private readonly client: SupabaseApproverMembershipRpcClient) {}

  async getActiveActor(
    userId: string,
    scope: { organizationId: string; workspaceId: string },
    grantId: string,
  ): Promise<AuthenticatedApprovalActor | null> {
    try {
      if (!userId.trim() || !grantId.trim() ||
          !scope.organizationId.trim() || !scope.workspaceId.trim()) return null;
      const result = await this.client.rpc(
        "resolve_authenticated_file_mutation_approver_membership",
        {
          p_grant_id: grantId,
          p_organization_id: scope.organizationId,
          p_workspace_id: scope.workspaceId,
        },
      );
      if (result.error) return null;
      const rows = Array.isArray(result.data)
        ? result.data
        : result.data === null || result.data === undefined ? [] : [result.data];
      if (rows.length !== 1 || !isRecord(rows[0])) return null;
      const row = rows[0];
      const returnedUserId = requiredString(row, "approver_user_id");
      const organizationId = requiredString(row, "organization_id");
      const workspaceId = requiredString(row, "workspace_id");
      const organizationRole = requiredString(row, "organization_role");
      const workspaceRole = requiredString(row, "workspace_role");
      if (returnedUserId !== userId || organizationId !== scope.organizationId ||
          workspaceId !== scope.workspaceId || !organizationRole || !workspaceRole) return null;
      return {
        userId: returnedUserId,
        organizationIds: [organizationId],
        workspaceIds: [workspaceId],
        organizationRole,
        workspaceRole,
      };
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
      // A grant-bound executor-JWT RPC may supply the approver's live role
      // evidence. Do not re-query auth.uid()-bound membership as another user.
      if (actor.organizationRole && actor.workspaceRole) {
        return this.rolePolicy(actor.organizationRole, actor.workspaceRole, role) === true;
      }
      const pair = await this.memberships.getTenantMembershipPair(
        actor.userId,
        scope.organizationId,
        scope.workspaceId,
      );
      const organization = pair?.organization;
      const workspace = pair?.workspace;
      if (!organization || !workspace ||
          organization.status !== "ACTIVE" || workspace.status !== "ACTIVE" ||
          organization.userId !== actor.userId || workspace.userId !== actor.userId ||
          organization.organizationId !== scope.organizationId ||
          workspace.organizationId !== scope.organizationId ||
          workspace.workspaceId !== scope.workspaceId ||
          !organization.role.trim() || !workspace.role.trim()) return false;
      return this.rolePolicy(organization.role, workspace.role, role) === true;
    } catch {
      return false;
    }
  }
}
