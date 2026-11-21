import type { CanonicalTenantContext } from "../tenant/canonical-tenant-context";
import type { WorkspaceFileExecutor } from "./workspace-code-executor";

export interface TenantWorkspaceBinding {
  userId: string;
  organizationId: string;
  workspaceId: string;
}

export interface ProvisionedTenantWorkspace {
  status: "PROVISIONED";
  binding: TenantWorkspaceBinding;
  /**
   * The provider must construct this executor over a durable, tenant-isolated
   * persistent volume. A process-local or deployment-root path is not valid.
   */
  executor: WorkspaceCodeExecutor;
  storage: "ISOLATED_PERSISTENT_VOLUME";
}

export type TenantWorkspaceProvisioningResult =
  | ProvisionedTenantWorkspace
  | { status: "NOT_YET_CONNECTED"; reason: string };

export interface TenantWorkspaceProvisioner {
  /**
   * Called only after request identity and exact organization/workspace
   * membership have been verified. The provider must not accept a path or
   * tenant identity from request payload.
   */
  provision(context: CanonicalTenantContext): Promise<TenantWorkspaceProvisioningResult>;
}

/**
 * Safe default until HAPPY has a deployed persistent-volume provider with
 * tenant-level isolation, ownership checks, quotas, and lifecycle controls.
 */
export class NotConnectedTenantWorkspaceProvisioner implements TenantWorkspaceProvisioner {
  async provision(): Promise<TenantWorkspaceProvisioningResult> {
    return {
      status: "NOT_YET_CONNECTED",
      reason: "A durable tenant-isolated workspace storage provider is not configured.",
    };
  }
}

/**
 * Resolve an executor only from a verified canonical tenant context and a
 * trusted server-side provisioner. Any mismatch or provider error fails closed.
 */
export async function resolveTenantWorkspaceExecutor(
  context: CanonicalTenantContext,
  provisioner: TenantWorkspaceProvisioner,
): Promise<
  | { status: "AVAILABLE"; executor: WorkspaceFileExecutor }
  | { status: "NOT_YET_CONNECTED"; reason: string }
> {
  const userId = context.actor?.userId?.trim();
  const organizationId = context.organizationId?.trim();
  const workspaceId = context.workspaceId?.trim();

  const actorOrganizationIds = context.actor?.organizationIds;
  const actorWorkspaceIds = context.actor?.workspaceIds;
  if (!userId || !organizationId || !workspaceId ||
      !context.organizationRole?.trim() || !context.workspaceRole?.trim() ||
      !Array.isArray(actorOrganizationIds) || !actorOrganizationIds.includes(organizationId) ||
      !Array.isArray(actorWorkspaceIds) || !actorWorkspaceIds.includes(workspaceId)) {
    return {
      status: "NOT_YET_CONNECTED",
      reason: "A verified canonical tenant context is required before workspace provisioning.",
    };
  }

  try {
    const result = await provisioner.provision(context);
    if (result.status !== "PROVISIONED") {
      return {
        status: "NOT_YET_CONNECTED",
        reason: result.reason || "Tenant workspace storage is not connected.",
      };
    }

    if (
      result.binding.userId !== userId ||
      result.binding.organizationId !== organizationId ||
      result.binding.workspaceId !== workspaceId ||
      result.storage !== "ISOLATED_PERSISTENT_VOLUME" ||
      !result.executor ||
      typeof result.executor.executeOperation !== "function"
    ) {
      return {
        status: "NOT_YET_CONNECTED",
        reason: "Workspace provider returned an invalid or cross-tenant binding.",
      };
    }

    return { status: "AVAILABLE", executor: result.executor };
  } catch {
    return {
      status: "NOT_YET_CONNECTED",
      reason: "Tenant workspace provisioning failed closed.",
    };
  }
}
