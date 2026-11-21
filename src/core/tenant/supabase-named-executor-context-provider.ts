import { createHash } from "node:crypto";
import type {
  NamedExecutorContext,
  NamedExecutorContextProvider,
  PersistedApproverMembershipProvider,
} from "../approval/named-executor-file-mutation-authorizer";
import type {
  ApprovalRoleAuthorizer,
  AuthenticatedApprovalActor,
} from "../approval/pipeline-approval-verifier";
import type { ExecutionCapability, ExecutionRequest, ExecutionRisk, ExecutionStatus } from "../execution/types";
import type { ResolvedReference } from "../context/types";
import {
  resolveCanonicalTenantContext,
  type CanonicalTenantMembershipStore,
} from "./canonical-tenant-context";
import type {
  SupabaseApproverMembershipRpcClient,
  SupabaseExecutionRequestCreateRpcClient,
  SupabaseExecutionRequestDecisionRpcClient,
  SupabaseExecutionRequestRpcClient,
} from "./supabase-private-tenant-stores";

export interface VerifiedServerIdentityProvider {
  /** Must call the server-side Supabase auth claims/session verifier. */
  getVerifiedIdentity(): Promise<{ userId: string } | null>;
}

export type DurableExecutionApprovalStatus = "NOT_REQUIRED" | "PENDING" | "APPROVED" | "REJECTED";

export interface DurableExecutionRequestRecord {
  requestId: string;
  taskId: string;
  missionId: string;
  requesterUserId: string;
  executorUserId: string;
  organizationId: string;
  workspaceId: string;
  executionRequest: ExecutionRequest;
  status: ExecutionStatus;
  approvalStatus: DurableExecutionApprovalStatus;
  requiredApprovalRole: "FOUNDER" | "ADMIN";
  inputDigest: string;
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

const EXECUTION_CAPABILITIES: readonly ExecutionCapability[] = [
  "CODE", "FILE", "API", "BROWSER", "SHELL", "DATABASE", "AI",
  "DEPLOYMENT", "PUBLISH", "AUTOMATION",
];
const EXECUTION_RISKS: readonly ExecutionRisk[] = ["LOW", "MEDIUM", "HIGH", "CRITICAL"];
const EXECUTION_STATUSES: readonly ExecutionStatus[] = [
  "RECEIVED", "WAITING_APPROVAL", "READY", "RUNNING", "COMPLETED",
  "FAILED", "BLOCKED", "NOT_YET_CONNECTED", "CANCELLED",
];
const APPROVAL_STATUSES: readonly DurableExecutionApprovalStatus[] = [
  "NOT_REQUIRED", "PENDING", "APPROVED", "REJECTED",
];

function parseResolvedReference(value: unknown): ResolvedReference | undefined | null {
  if (value === null || value === undefined) return undefined;
  if (!isRecord(value) ||
      typeof value.token !== "string" || !value.token.trim() ||
      !["PROJECT", "MISSION", "TASK", "FILE", "DATABASE"].includes(String(value.entityType)) ||
      typeof value.entityId !== "string" || !value.entityId.trim() ||
      !["HIGH", "MEDIUM", "LOW", "UNKNOWN"].includes(String(value.confidence)) ||
      !["ACTIVE_CONTEXT", "PERSISTED_MEMORY"].includes(String(value.source))) return null;
  return value as unknown as ResolvedReference;
}

function canonicalJson(value: unknown): string | null {
  try {
    const normalize = (item: unknown): unknown => {
      if (item === null || typeof item === "string" || typeof item === "boolean") return item;
      if (typeof item === "number" && Number.isFinite(item)) return item;
      if (Array.isArray(item)) return item.map(normalize);
      if (isRecord(item)) {
        return Object.fromEntries(
          Object.keys(item).sort().map((key) => [key, normalize(item[key])]),
        );
      }
      throw new Error("Execution envelope contains a non-JSON value.");
    };
    return JSON.stringify(normalize(value));
  } catch {
    return null;
  }
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
      const capability = requiredString(row, "capability");
      const action = requiredString(row, "action");
      const risk = requiredString(row, "risk");
      const approvalStatus = requiredString(row, "approval_status");
      const requiredApprovalRole = requiredString(row, "required_approval_role");
      const status = requiredString(row, "status");
      const inputDigest = requiredString(row, "input_digest");
      const createdAt = requiredString(row, "created_at");
      const targetReference = parseResolvedReference(row.target_reference);
      if (!request || !task || !mission || !requester || !executor ||
          !organization || !workspace || !capability || !action || !risk ||
          !approvalStatus || !requiredApprovalRole || !status || !inputDigest || !createdAt ||
          !EXECUTION_CAPABILITIES.includes(capability as ExecutionCapability) ||
          !EXECUTION_RISKS.includes(risk as ExecutionRisk) ||
          !APPROVAL_STATUSES.includes(approvalStatus as DurableExecutionApprovalStatus) ||
          approvalStatus === "NOT_REQUIRED" ||
          !["FOUNDER", "ADMIN"].includes(requiredApprovalRole) ||
          !EXECUTION_STATUSES.includes(status as ExecutionStatus) ||
          row.requires_approval !== true ||
          risk !== "HIGH" ||
          requiredApprovalRole !== "FOUNDER" ||
          (approvalStatus === "PENDING" && status !== "WAITING_APPROVAL") ||
          (approvalStatus === "APPROVED" && !["READY", "RUNNING", "COMPLETED", "FAILED", "BLOCKED", "NOT_YET_CONNECTED"].includes(status)) ||
          (approvalStatus === "REJECTED" && status !== "CANCELLED") ||
          !/^[0-9a-f]{64}$/.test(inputDigest) ||
          typeof row.requires_approval !== "boolean" ||
          !isRecord(row.input) || targetReference === null) return null;

      return {
        requestId: request,
        taskId: task,
        missionId: mission,
        requesterUserId: requester,
        executorUserId: executor,
        organizationId: organization,
        workspaceId: workspace,
        executionRequest: {
          id: request,
          taskId: task,
          missionId: mission,
          capability: capability as ExecutionCapability,
          action,
          input: row.input,
          ...(targetReference ? { targetReference } : {}),
          requiresApproval: row.requires_approval,
          approved: approvalStatus === "APPROVED" || approvalStatus === "NOT_REQUIRED",
          risk: risk as ExecutionRisk,
          createdAt,
        },
        status: status as ExecutionStatus,
        approvalStatus: approvalStatus as DurableExecutionApprovalStatus,
        requiredApprovalRole: requiredApprovalRole as "FOUNDER" | "ADMIN",
        inputDigest,
      };
    } catch {
      return null;
    }
  }
}

export interface CreateDurableExecutionRequestCommand {
  requestId: string;
  taskId: string;
  missionId: string;
  organizationId: string;
  workspaceId: string;
  capability: ExecutionCapability;
  action: string;
  input: Record<string, unknown>;
  targetReference?: ResolvedReference;
  idempotencyKey: string;
}

/**
 * Creates only high-risk, founder-gated durable envelopes. The database RPC
 * derives requester/executor from auth.uid(), checks active tenant membership,
 * and binds the idempotency key to the complete immutable envelope.
 */
export class SupabaseDurableExecutionRequestCreator {
  constructor(private readonly client: SupabaseExecutionRequestCreateRpcClient) {}

  async create(command: CreateDurableExecutionRequestCommand): Promise<string | null> {
    try {
      if (!command.requestId.trim() || !command.taskId.trim() || !command.missionId.trim() ||
          !command.organizationId.trim() || !command.workspaceId.trim() ||
          command.requestId.length > 160 || command.taskId.length > 160 ||
          command.missionId.length > 160 || command.idempotencyKey.length > 160 ||
          !EXECUTION_CAPABILITIES.includes(command.capability) ||
          !command.action.trim() || command.action.length > 200 ||
          !isRecord(command.input) || !command.idempotencyKey.trim() ||
          parseResolvedReference(command.targetReference ?? null) === null) return null;
      const canonicalEnvelope = canonicalJson({
        requestId: command.requestId,
        taskId: command.taskId,
        missionId: command.missionId,
        organizationId: command.organizationId,
        workspaceId: command.workspaceId,
        capability: command.capability,
        action: command.action,
        input: command.input,
        targetReference: command.targetReference ?? null,
        risk: "HIGH",
        requiresApproval: true,
        requiredApprovalRole: "FOUNDER",
        idempotencyKey: command.idempotencyKey,
      });
      if (canonicalEnvelope === null) return null;
      const inputDigest = createHash("sha256").update(canonicalEnvelope, "utf8").digest("hex");
      const result = await this.client.rpc("create_authenticated_execution_request", {
        p_request_id: command.requestId,
        p_task_id: command.taskId,
        p_mission_id: command.missionId,
        p_organization_id: command.organizationId,
        p_workspace_id: command.workspaceId,
        p_capability: command.capability,
        p_action: command.action,
        p_input: command.input,
        p_target_reference: command.targetReference ?? null,
        p_idempotency_key: command.idempotencyKey,
        p_input_digest: inputDigest,
      });
      if (result.error) return null;
      const rows = Array.isArray(result.data)
        ? result.data
        : result.data === null || result.data === undefined ? [] : [result.data];
      if (rows.length !== 1 || !isRecord(rows[0])) return null;
      const row = rows[0];
      const matchesEnvelope = typeof row.request_id === "string" && row.request_id.length > 0 &&
        row.task_id === command.taskId &&
        row.mission_id === command.missionId &&
        row.organization_id === command.organizationId &&
        row.workspace_id === command.workspaceId &&
        row.capability === command.capability &&
        row.action === command.action &&
        canonicalJson(row.input) === canonicalJson(command.input) &&
        canonicalJson(row.target_reference ?? null) === canonicalJson(command.targetReference ?? null) &&
        row.risk === "HIGH" &&
        row.requires_approval === true &&
        ["PENDING", "APPROVED", "REJECTED"].includes(String(row.approval_status)) &&
        row.required_approval_role === "FOUNDER" &&
        ["WAITING_APPROVAL", "READY", "CANCELLED"].includes(String(row.status)) &&
        row.idempotency_key === command.idempotencyKey &&
        row.input_digest === inputDigest &&
        typeof row.requester_user_id === "string" &&
        row.requester_user_id.length > 0 &&
        row.executor_user_id === row.requester_user_id;
      return matchesEnvelope ? row.request_id as string : null;
    } catch {
      return null;
    }
  }
}

/** Atomic decision RPC adapter. Identity and approver role are derived in PostgreSQL. */
export class SupabaseExecutionRequestApprovalDecisionStore {
  constructor(private readonly client: SupabaseExecutionRequestDecisionRpcClient) {}

  async decide(
    requestId: string,
    decision: "APPROVED" | "REJECTED",
    reason: string,
  ): Promise<boolean> {
    try {
      if (!requestId.trim() || !reason.trim() || reason.length > 1000) return false;
      const result = await this.client.rpc("decide_authenticated_execution_request", {
        p_request_id: requestId,
        p_decision: decision,
        p_reason: reason,
      });
      if (result.error) return false;
      if (result.data === true) return true;
      if (Array.isArray(result.data) && result.data.length === 1) {
        const value = result.data[0];
        if (value === true || (isRecord(value) && value.decided === true)) return true;
      }
      return isRecord(result.data) && result.data.decided === true;
    } catch {
      return false;
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

      const persisted = durable.executionRequest;
      if (persisted.id !== request.id ||
          persisted.taskId !== request.taskId ||
          persisted.missionId !== request.missionId ||
          persisted.capability !== request.capability ||
          persisted.action !== request.action ||
          persisted.risk !== request.risk ||
          persisted.requiresApproval !== request.requiresApproval ||
          persisted.approved !== request.approved ||
          persisted.createdAt !== request.createdAt ||
          canonicalJson(persisted.input) === null ||
          canonicalJson(persisted.input) !== canonicalJson(request.input) ||
          canonicalJson(persisted.targetReference ?? null) !== canonicalJson(request.targetReference ?? null) ||
          (durable.approvalStatus === "PENDING" && durable.status !== "WAITING_APPROVAL") ||
          (durable.approvalStatus === "APPROVED" && !["READY", "RUNNING"].includes(durable.status)) ||
          (durable.approvalStatus === "REJECTED" || durable.status === "CANCELLED") ||
          (request.requiresApproval && durable.approvalStatus !== "APPROVED") ||
          (!request.requiresApproval && durable.approvalStatus !== "NOT_REQUIRED") ||
          (durable.status !== "READY" && durable.status !== "RUNNING")) return null;

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
