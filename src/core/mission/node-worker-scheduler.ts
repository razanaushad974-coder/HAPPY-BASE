import type { TenantScope } from "../state/types";
import type { WorkerTenantScope } from "./worker-database-broker";
import type { VerifiedWorkerIdentity } from "./trusted-worker-identity";
import type { WorkerPrincipalRegistration } from "./worker-database-broker";
import { composeTrustedWorkerRuntime } from "./worker-runtime-composition";
import type { WorkerRuntimeCompositionDependencies } from "./worker-runtime-composition";
import type { createNodePostgresHappyWorker } from "./node-postgres-happy-worker";

export type NodeWorkerOperation = "READY_TASK" | "PENDING_DISPATCH";

export interface AuthorizedNodeWorkerTenant {
  readonly scope: TenantScope & { readonly userId: string };
  readonly workerScope: WorkerTenantScope;
  /** Opaque cursor owned by the host's authorized grant scanner. */
  readonly nextCursor: string | null;
}

/**
 * Host adapter over an authoritative tenant-grant RPC.
 * It must return only active grants for the exact attested principal and must
 * never enumerate arbitrary tenant IDs from environment, requests, or payloads.
 */
export interface AuthorizedWorkerTenantScopeSource {
  nextAuthorizedTenant(input: {
    readonly identity: VerifiedWorkerIdentity;
    readonly registration: WorkerPrincipalRegistration;
    readonly cursor: string | null;
    readonly signal?: AbortSignal;
  }): Promise<AuthorizedNodeWorkerTenant | null>;
}

export interface NodeWorkerBatchResult {
  readonly status: "COMPLETED" | "STOPPED" | "DENIED" | "NOT_CONNECTED";
  readonly operation: NodeWorkerOperation;
  readonly tenantsVisited: number;
  readonly results: readonly Readonly<Record<string, unknown>>[];
  readonly reason?: string;
}

/**
 * Runs a bounded, single-concurrency Node worker batch.
 *
 * Identity and principal registration are freshly resolved before each grant
 * scan. Each resulting tenant operation then goes through the worker's own
 * per-broker-operation identity/registry reauthorization and PostgreSQL
 * session_user/current_user checks. The host grant scanner remains a required
 * adapter and must query authoritative grants; this function never trusts a
 * tenant scope supplied by a user or arbitrary caller.
 */
export async function runNodeWorkerBatch(input: {
  readonly dependencies: WorkerRuntimeCompositionDependencies;
  readonly tenantScopeSource: AuthorizedWorkerTenantScopeSource;
  readonly worker: ReturnType<typeof createNodePostgresHappyWorker>;
  readonly operation: NodeWorkerOperation;
  readonly maxTenants: number;
  readonly signal?: AbortSignal;
}): Promise<NodeWorkerBatchResult> {
  if (!Number.isSafeInteger(input.maxTenants) || input.maxTenants < 1 || input.maxTenants > 20) {
    throw new RangeError("Node worker batch maxTenants must be between 1 and 20.");
  }
  if (input.operation !== "READY_TASK" && input.operation !== "PENDING_DISPATCH") {
    throw new TypeError("Unsupported Node worker operation.");
  }

  const results: Readonly<Record<string, unknown>>[] = [];
  let cursor: string | null = null;
  let tenantsVisited = 0;
  const seenTenantBindings = new Set<string>();

  while (tenantsVisited < input.maxTenants) {
    if (input.signal?.aborted) {
      return { status: "STOPPED", operation: input.operation, tenantsVisited, results };
    }

    const composition = await composeTrustedWorkerRuntime({
      dependencies: input.dependencies,
      operation: input.operation === "READY_TASK" ? "claim_task" : "claim_next_dispatch",
    });
    if (composition.status !== "COMPOSITION_AVAILABLE") {
      return {
        status: composition.status === "NOT_CONNECTED" ? "NOT_CONNECTED" : "DENIED",
        operation: input.operation,
        tenantsVisited,
        results,
        reason: composition.status === "NOT_CONNECTED" ? composition.missing : composition.reason,
      };
    }

    let tenant: AuthorizedNodeWorkerTenant | null;
    try {
      tenant = await input.tenantScopeSource.nextAuthorizedTenant({
        identity: composition.identity,
        registration: composition.registration,
        cursor,
        ...(input.signal ? { signal: input.signal } : {}),
      });
    } catch {
      return {
        status: "DENIED",
        operation: input.operation,
        tenantsVisited,
        results,
        reason: "TENANT_GRANT_RESOLUTION_FAILED",
      };
    }
    if (!tenant) {
      return { status: "COMPLETED", operation: input.operation, tenantsVisited, results };
    }

    const scope = tenant.scope;
    const workerScope = tenant.workerScope;
    if (
      !scope || !workerScope ||
      typeof scope.organizationId !== "string" || !scope.organizationId.trim() ||
      typeof scope.workspaceId !== "string" || !scope.workspaceId.trim() ||
      typeof scope.userId !== "string" || !scope.userId.trim() ||
      workerScope.workerPrincipalId !== composition.registration.principalId ||
      workerScope.organizationId !== scope.organizationId ||
      workerScope.workspaceId !== scope.workspaceId ||
      workerScope.userId !== scope.userId ||
      (tenant.nextCursor !== null &&
        (typeof tenant.nextCursor !== "string" || !tenant.nextCursor.trim() || tenant.nextCursor.length > 1024)) ||
      tenant.nextCursor === cursor
    ) {
      return {
        status: "DENIED",
        operation: input.operation,
        tenantsVisited,
        results,
        reason: "TENANT_GRANT_SCOPE_MISMATCH",
      };
    }

    const tenantBinding = [
      scope.organizationId,
      scope.workspaceId,
      scope.userId,
      workerScope.workerPrincipalId,
    ].join("\u001f");
    if (seenTenantBindings.has(tenantBinding)) {
      return {
        status: "DENIED",
        operation: input.operation,
        tenantsVisited,
        results,
        reason: "TENANT_GRANT_SCAN_DUPLICATE",
      };
    }
    seenTenantBindings.add(tenantBinding);

    // Advance only after validating the exact tenant binding. Sequential awaits
    // guarantee concurrency=1 and make cancellation take effect between jobs.
    cursor = tenant.nextCursor;
    tenantsVisited += 1;
    try {
      const result = input.operation === "READY_TASK"
        ? await input.worker.runOneReadyTask({ scope, workerScope })
        : await input.worker.runOnePendingDispatch(workerScope);
      results.push(Object.freeze({ tenant: {
        organizationId: scope.organizationId,
        workspaceId: scope.workspaceId,
        userId: scope.userId,
      }, result }));
    } catch {
      results.push(Object.freeze({
        tenant: {
          organizationId: scope.organizationId,
          workspaceId: scope.workspaceId,
          userId: scope.userId,
        },
        result: { status: "WORKER_OPERATION_FAILED" },
      }));
      // Stop on any failed tenant operation; do not keep scanning after an
      // authorization, database, or provider failure whose state may be unclear.
      return {
        status: "STOPPED",
        operation: input.operation,
        tenantsVisited,
        results,
        reason: "WORKER_OPERATION_FAILED",
      };
    }
  }

  return {
    status: input.signal?.aborted ? "STOPPED" : "COMPLETED",
    operation: input.operation,
    tenantsVisited,
    results,
    ...(tenantsVisited === input.maxTenants
      ? { reason: "BATCH_LIMIT_REACHED" }
      : {}),
  };
}
