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
  select(columns: string): SupabaseQuery;
  update(values: Record<string, unknown>): SupabaseQuery;
  eq(column: string, value: string | number | boolean): SupabaseQuery;
  is(column: string, value: null | boolean): SupabaseQuery;
  gt(column: string, value: string): SupabaseQuery;
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

function membershipStatus(value: unknown): "ACTIVE" | "SUSPENDED" | "REVOKED" | null {
  return value === "ACTIVE" || value === "SUSPENDED" || value === "REVOKED"
    ? value
    : null;
}

const PRIVATE = "private";
const GRANT_COLUMNS = [
  "grant_id", "request_id", "task_id", "mission_id",
  "requester_user_id", "executor_user_id", "approver_user_id",
  "organization_id", "workspace_id", "target_entity_type",
  "target_entity_id", "operation", "source_path", "destination_path",
  "input_digest", "required_role", "status", "expires_at", "consumed_at",
].join(",");

export class SupabaseCanonicalTenantMembershipStore
implements CanonicalTenantMembershipStore {
  constructor(private readonly client: SupabasePrivateSchemaClient) {}

  async getOrganizationMembership(
    userId: string,
    organizationId: string,
  ): Promise<OrganizationMembershipRecord | null> {
    const result = await this.client.schema(PRIVATE)
      .from("organization_memberships")
      .select("user_id,organization_id,status,role")
      .eq("user_id", userId)
      .eq("organization_id", organizationId)
      .maybeSingle();
    if (result.error || !isRecord(result.data)) return null;
    const user = stringField(result.data, "user_id");
    const organization = stringField(result.data, "organization_id");
    const status = membershipStatus(result.data.status);
    const role = stringField(result.data, "role");
    if (!user || !organization || !status || !role) return null;
    return { userId: user, organizationId: organization, status, role };
  }

  async getWorkspaceMembership(
    userId: string,
    organizationId: string,
    workspaceId: string,
  ): Promise<WorkspaceMembershipRecord | null> {
    const result = await this.client.schema(PRIVATE)
      .from("workspace_memberships")
      .select("user_id,organization_id,workspace_id,status,role")
      .eq("user_id", userId)
      .eq("organization_id", organizationId)
      .eq("workspace_id", workspaceId)
      .maybeSingle();
    if (result.error || !isRecord(result.data)) return null;
    const user = stringField(result.data, "user_id");
    const organization = stringField(result.data, "organization_id");
    const workspace = stringField(result.data, "workspace_id");
    const status = membershipStatus(result.data.status);
    const role = stringField(result.data, "role");
    if (!user || !organization || !workspace || !status || !role) return null;
    return {
      userId: user,
      organizationId: organization,
      workspaceId: workspace,
      status,
      role,
    };
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

  async consumeApprovedGrant(
    scope: { organizationId: string; workspaceId: string },
    grantId: string,
    binding: NamedExecutorGrantBinding,
    consumedAt: string,
  ): Promise<boolean> {
    try {
      let query = this.client.schema(PRIVATE)
        .from("file_mutation_approval_grants")
        .update({ status: "CONSUMED", consumed_at: consumedAt, updated_at: consumedAt })
        .eq("grant_id", grantId)
        .eq("organization_id", scope.organizationId)
        .eq("workspace_id", scope.workspaceId)
        .eq("request_id", binding.requestId)
        .eq("task_id", binding.taskId)
        .eq("mission_id", binding.missionId)
        .eq("requester_user_id", binding.requesterUserId)
        .eq("executor_user_id", binding.executorUserId)
        .eq("approver_user_id", binding.approverUserId)
        .eq("target_entity_type", "FILE")
        .eq("target_entity_id", binding.targetEntityId)
        .eq("operation", binding.operation)
        .eq("source_path", binding.sourcePath)
        .eq("input_digest", binding.inputDigest)
        .eq("status", "APPROVED")
        .is("consumed_at", null)
        .gt("expires_at", consumedAt);
      query = binding.destinationPath === null
        ? query.is("destination_path", null)
        : query.eq("destination_path", binding.destinationPath);
      const result = await query.select("grant_id").maybeSingle();
      return !result.error && isRecord(result.data) && result.data.grant_id === grantId;
    } catch {
      return false;
    }
  }
}
