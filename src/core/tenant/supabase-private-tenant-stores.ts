import type {
  CanonicalTenantMembershipStore,
  OrganizationMembershipRecord,
  WorkspaceMembershipRecord,
} from "../tenant/canonical-tenant-context";
import type {
  NamedExecutorGrant,
  NamedExecutorGrantBinding,
  NamedExecutorGrantLookup,
  NamedExecutorGrantStore,
} from "../approval/named-executor-file-mutation-authorizer";

type DatabaseError = { message?: string } | null;
type DatabaseResult = { data: unknown; error: DatabaseError };

export interface SupabasePrivateQuery {
  select(columns: string): SupabasePrivateQuery;
  update(values: Record<string, unknown>): SupabasePrivateQuery;
  eq(column: string, value: string | number | boolean): SupabasePrivateQuery;
  is(column: string, value: null | boolean): SupabasePrivateQuery;
  gt(column: string, value: string): SupabasePrivateQuery;
  maybeSingle(): Promise<DatabaseResult>;
}

export interface SupabasePrivateSchema {
  from(table: string): SupabasePrivateQuery;
}

/**
 * Minimal structural boundary for a server-only Supabase client.
 * Pass a client created in trusted server composition; never expose this
 * adapter or a service-role client to browser code.
 */
export interface SupabasePrivateSchemaClient {
  schema(name: "private"): SupabasePrivateSchema;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function stringField(row: Record<string, unknown>, key: string): string | null {
  const value = row[key];
  return typeof value === "string" && value.trim() ? value : null;
}

const PRIVATE = "private";
const GRANT_COLUMNS = [
  "grant_id", "request_id", "task_id", "mission_id",
  "requester_user_id", "executor_user_id", "approver_user_id",
  "organization_id", "workspace_id", "target_entity_type",
  "target_entity_id", "operation", "source_path", "destination_path",
  "input_digest", "required_role", "status", "expires_at", "consumed_at",
].join(",");

/**
 * A narrow RPC boundary for resolving the current authenticated user's
 * membership. The database function derives the principal from auth.uid();
 * caller-supplied user IDs are never sent to PostgreSQL.
 */
export interface SupabaseTenantContextRpcClient {
  rpc(
    functionName: "resolve_authenticated_tenant_context",
    args: { p_organization_id: string; p_workspace_id: string },
  ): Promise<DatabaseResult>;
}

/**
 * User-scoped RPC for loading the immutable execution request assigned to
 * auth.uid(). It intentionally exposes no private-schema table query surface.
 */
/** Executor-JWT RPC resolves the persisted approver's current membership for one exact grant. */
export interface SupabaseApproverMembershipRpcClient {
  rpc(
    functionName: "resolve_authenticated_file_mutation_approver_membership",
    args: {
      p_grant_id: string;
      p_organization_id: string;
      p_workspace_id: string;
    },
  ): Promise<DatabaseResult>;
}

export interface SupabaseExecutionRequestRpcClient {
  rpc(
    functionName: "resolve_authenticated_execution_request",
    args: { p_request_id: string },
  ): Promise<DatabaseResult>;
}

/** Request creation RPC: database derives requester/executor and forces founder approval. */
export interface SupabaseExecutionRequestCreateRpcClient {
  rpc(
    functionName: "create_authenticated_execution_request",
    args: {
      p_request_id: string;
      p_task_id: string;
      p_mission_id: string;
      p_organization_id: string;
      p_workspace_id: string;
      p_capability: "CODE" | "FILE" | "API" | "BROWSER" | "SHELL" | "DATABASE" | "AI" | "DEPLOYMENT" | "PUBLISH" | "AUTOMATION";
      p_action: string;
      p_input: Record<string, unknown>;
      p_target_reference: Record<string, unknown> | null;
      p_idempotency_key: string;
    },
  ): Promise<DatabaseResult>;
}

export class SupabaseCanonicalTenantMembershipStore
implements CanonicalTenantMembershipStore {
  constructor(private readonly client: SupabaseTenantContextRpcClient) {}

  async getTenantMembershipPair(
    userId: string,
    organizationId: string,
    workspaceId: string,
  ): Promise<{
    organization: OrganizationMembershipRecord;
    workspace: WorkspaceMembershipRecord;
  } | null> {
    try {
      const result = await this.client.rpc("resolve_authenticated_tenant_context", {
        p_organization_id: organizationId,
        p_workspace_id: workspaceId,
      });
      if (result.error) return null;
      const rows = Array.isArray(result.data)
        ? result.data
        : result.data === null || result.data === undefined
          ? []
          : [result.data];
      if (rows.length !== 1 || !isRecord(rows[0])) return null;

      const row = rows[0];
      const returnedUserId = stringField(row, "user_id");
      const returnedOrganizationId = stringField(row, "organization_id");
      const returnedWorkspaceId = stringField(row, "workspace_id");
      const organizationRole = stringField(row, "organization_role");
      const workspaceRole = stringField(row, "workspace_role");
      if (
        returnedUserId !== userId ||
        returnedOrganizationId !== organizationId ||
        returnedWorkspaceId !== workspaceId ||
        !organizationRole ||
        !workspaceRole
      ) return null;

      return {
        organization: {
          userId: returnedUserId,
          organizationId: returnedOrganizationId,
          status: "ACTIVE",
          role: organizationRole,
        },
        workspace: {
          userId: returnedUserId,
          organizationId: returnedOrganizationId,
          workspaceId: returnedWorkspaceId,
          status: "ACTIVE",
          role: workspaceRole,
        },
      };
    } catch {
      return null;
    }
  }
}

/**
 * Authenticated, executor-bound RPC for looking up one exact approved FILE grant.
 * The database derives the executor from auth.uid(); the client supplies only
 * immutable request/operation binding fields.
 */
export interface SupabaseNamedExecutorGrantLookupRpcClient {
  rpc(
    functionName: "resolve_authenticated_file_mutation_approval_grant",
    args: {
      p_organization_id: string;
      p_workspace_id: string;
      p_request_id: string;
      p_task_id: string;
      p_mission_id: string;
      p_requester_user_id: string;
      p_target_entity_id: string;
      p_operation: NamedExecutorGrantLookup["operation"];
      p_source_path: string;
      p_destination_path: string | null;
      p_input_digest: string;
    },
  ): Promise<DatabaseResult>;
}

/** No private-schema or service-role table reader is needed for grant discovery. */
export class SupabaseAuthenticatedNamedExecutorGrantLookupStore implements NamedExecutorGrantStore {
  constructor(private readonly client: SupabaseNamedExecutorGrantLookupRpcClient) {}

  async getApprovedGrant(
    scope: { organizationId: string; workspaceId: string },
    binding: NamedExecutorGrantLookup,
  ): Promise<NamedExecutorGrant | null> {
    try {
      if (
        !scope.organizationId.trim() || !scope.workspaceId.trim() ||
        binding.organizationId !== scope.organizationId ||
        binding.workspaceId !== scope.workspaceId ||
        !binding.requestId.trim() || !binding.taskId.trim() ||
        !binding.missionId.trim() || !binding.requesterUserId.trim() ||
        !binding.targetEntityId.trim() || !binding.sourcePath.trim() ||
        !/^[0-9a-f]{64}$/.test(binding.inputDigest)
      ) return null;
      const result = await this.client.rpc(
        "resolve_authenticated_file_mutation_approval_grant",
        {
          p_organization_id: scope.organizationId,
          p_workspace_id: scope.workspaceId,
          p_request_id: binding.requestId,
          p_task_id: binding.taskId,
          p_mission_id: binding.missionId,
          p_requester_user_id: binding.requesterUserId,
          p_target_entity_id: binding.targetEntityId,
          p_operation: binding.operation,
          p_source_path: binding.sourcePath,
          p_destination_path: binding.destinationPath,
          p_input_digest: binding.inputDigest,
        },
      );
      if (result.error) return null;
      const rows = Array.isArray(result.data)
        ? result.data
        : result.data === null || result.data === undefined ? [] : [result.data];
      if (rows.length !== 1 || !isRecord(rows[0])) return null;
      const row = rows[0];
      const grantId = stringField(row, "grant_id");
      const approverUserId = stringField(row, "approver_user_id");
      const executorUserId = stringField(row, "executor_user_id");
      const expiresAt = stringField(row, "expires_at");
      if (
        !grantId || !approverUserId || !executorUserId || !expiresAt ||
        row.request_id !== binding.requestId ||
        row.task_id !== binding.taskId ||
        row.mission_id !== binding.missionId ||
        row.requester_user_id !== binding.requesterUserId ||
        executorUserId !== binding.executorUserId ||
        row.organization_id !== scope.organizationId ||
        row.workspace_id !== scope.workspaceId ||
        row.target_entity_type !== "FILE" ||
        row.target_entity_id !== binding.targetEntityId ||
        row.operation !== binding.operation ||
        row.source_path !== binding.sourcePath ||
        row.destination_path !== binding.destinationPath ||
        row.input_digest !== binding.inputDigest ||
        row.status !== "APPROVED" ||
        row.consumed_at !== null ||
        (row.required_role !== "FOUNDER" && row.required_role !== "ADMIN")
      ) return null;
      return {
        ...binding,
        grantId,
        executorUserId,
        approverUserId,
        requiredRole: row.required_role,
        status: "APPROVED",
        expiresAt,
      };
    } catch {
      return null;
    }
  }

  async consumeApprovedGrant(
    _scope: { organizationId: string; workspaceId: string },
    _grantId: string,
    _binding: NamedExecutorGrantBinding,
    _consumedAt: string,
  ): Promise<boolean> {
    // Lookup is deliberately read-only. Consumption belongs to the separate
    // executor-JWT transactional RPC adapter.
    return false;
  }
}

/**
 * Supabase implementation of the named-executor grant contract.
 * The consume operation is exactly one conditional UPDATE followed by
 * RETURNING; there is no read-then-write authorization window.
 */
export class SupabaseNamedExecutorGrantStore implements NamedExecutorGrantStore {
  constructor(private readonly client: SupabasePrivateSchemaClient) {}

  async getApprovedGrant(
    scope: { organizationId: string; workspaceId: string },
    binding: NamedExecutorGrantLookup,
  ): Promise<NamedExecutorGrant | null> {
    try {
      let query = this.client.schema(PRIVATE)
        .from("file_mutation_approval_grants")
        .select(GRANT_COLUMNS)
        .eq("organization_id", scope.organizationId)
        .eq("workspace_id", scope.workspaceId)
        .eq("request_id", binding.requestId)
        .eq("task_id", binding.taskId)
        .eq("mission_id", binding.missionId)
        .eq("requester_user_id", binding.requesterUserId)
        .eq("executor_user_id", binding.executorUserId)
        .eq("target_entity_type", "FILE")
        .eq("target_entity_id", binding.targetEntityId)
        .eq("operation", binding.operation)
        .eq("source_path", binding.sourcePath)
        .eq("input_digest", binding.inputDigest)
        .eq("status", "APPROVED")
        .is("consumed_at", null);
      query = binding.destinationPath === null
        ? query.is("destination_path", null)
        : query.eq("destination_path", binding.destinationPath);
      const result = await query.maybeSingle();
      if (result.error || !isRecord(result.data)) return null;
      const row = result.data;
      const requiredRole = row.required_role;
      const status = row.status;
      if (
        requiredRole !== "FOUNDER" && requiredRole !== "ADMIN"
      ) return null;
      if (status !== "APPROVED" && status !== "REVOKED" &&
          status !== "EXPIRED" && status !== "CONSUMED") return null;
      const grantId = stringField(row, "grant_id");
      const requestId = stringField(row, "request_id");
      const taskId = stringField(row, "task_id");
      const missionId = stringField(row, "mission_id");
      const requesterUserId = stringField(row, "requester_user_id");
      const executorUserId = stringField(row, "executor_user_id");
      const approverUserId = stringField(row, "approver_user_id");
      const organizationId = stringField(row, "organization_id");
      const workspaceId = stringField(row, "workspace_id");
      const targetEntityId = stringField(row, "target_entity_id");
      const operation = row.operation;
      const sourcePath = stringField(row, "source_path");
      const inputDigest = stringField(row, "input_digest");
      const expiresAt = stringField(row, "expires_at");
      const destinationPath = row.destination_path;
      if (
        !grantId || !requestId || !taskId || !missionId || !requesterUserId ||
        !executorUserId || !approverUserId || !organizationId || !workspaceId ||
        row.target_entity_type !== "FILE" || !targetEntityId ||
        !["CREATE", "MODIFY", "COPY", "MOVE", "RENAME", "DELETE"].includes(String(operation)) ||
        !sourcePath || !inputDigest || !expiresAt ||
        (destinationPath !== null && typeof destinationPath !== "string")
      ) return null;
      return {
        grantId, requestId, taskId, missionId, requesterUserId, executorUserId,
        approverUserId, organizationId, workspaceId, targetEntityType: "FILE",
        targetEntityId, operation: operation as NamedExecutorGrant["operation"],
        sourcePath, destinationPath: destinationPath as string | null,
        inputDigest, requiredRole, status,
        expiresAt,
        ...(typeof row.consumed_at === "string" ? { consumedAt: row.consumed_at } : {}),
      };
    } catch {
      return null;
    }
  }

  /**
   * Direct private-table consumption is intentionally disabled. Authenticated
   * callers have no private-table UPDATE grant, and privileged server clients
   * must not bypass the auth.uid()-bound transactional consume RPC.
   */
  async consumeApprovedGrant(
    _scope: { organizationId: string; workspaceId: string },
    _grantId: string,
    _binding: NamedExecutorGrantBinding,
    _consumedAt: string,
  ): Promise<boolean> {
    return false;
  }
}


/**
 * A narrow RPC boundary for the transactional consume function. The supplied
 * client MUST be a server-side, user-scoped Supabase client carrying the
 * executor's verified JWT. A service-role client is not valid here because
 * auth.uid() must resolve to the end-user executor inside PostgreSQL.
 */
export interface VerifiedExecutorUserScopedRpcClient {
  rpc(
    functionName: "consume_file_mutation_approval_grant",
    args: Record<string, unknown>,
  ): Promise<DatabaseResult>;
}

/**
 * Production-shaped adapter for the database transaction candidate.
 * Grant discovery may use a separate trusted private-schema reader, but the
 * final consume always runs through the executor's user-scoped JWT RPC client.
 * No requester/executor/approver IDs are sent to the RPC: the database derives
 * them from auth.uid(), the durable execution request, and the persisted grant.
 */
export class SupabaseTransactionalNamedExecutorGrantStore implements NamedExecutorGrantStore {
  constructor(
    private readonly lookupStore: Pick<NamedExecutorGrantStore, "getApprovedGrant">,
    private readonly executorRpcClient: VerifiedExecutorUserScopedRpcClient,
  ) {}

  getApprovedGrant(
    scope: { organizationId: string; workspaceId: string },
    binding: NamedExecutorGrantLookup,
  ): Promise<NamedExecutorGrant | null> {
    return this.lookupStore.getApprovedGrant(scope, binding);
  }

  async consumeApprovedGrant(
    scope: { organizationId: string; workspaceId: string },
    grantId: string,
    binding: NamedExecutorGrantBinding,
    _consumedAt: string,
  ): Promise<boolean> {
    try {
      const result = await this.executorRpcClient.rpc(
        "consume_file_mutation_approval_grant",
        {
          p_grant_id: grantId,
          p_organization_id: scope.organizationId,
          p_workspace_id: scope.workspaceId,
          p_request_id: binding.requestId,
          p_task_id: binding.taskId,
          p_mission_id: binding.missionId,
          p_target_entity_id: binding.targetEntityId,
          p_operation: binding.operation,
          p_source_path: binding.sourcePath,
          p_destination_path: binding.destinationPath,
          p_input_digest: binding.inputDigest,
        },
      );
      return !result.error && result.data === true;
    } catch {
      return false;
    }
  }
}
