import type {
  AdapterStatus,
  ExecutionAdapter,
  ExecutionRequest,
  ExecutionResult,
} from "./types";

import type {
  WorkspaceFileExecutor,
  WorkspaceFileOperationRequest,
  WorkspaceFileOperationResult,
} from "./workspace-code-executor";

function baseResult(
  request: ExecutionRequest,
  status: ExecutionResult["status"],
  startedAt: string,
): ExecutionResult {
  return {
    id: crypto.randomUUID(),
    requestId: request.id,
    capability: request.capability,
    status,
    evidenceIds: [],
    startedAt,
    completedAt: new Date().toISOString(),
  };
}

function normalizeOperation(
  value: Record<string, unknown>,
): WorkspaceFileOperationRequest | null {
  const action =
    typeof value.operation === "string"
      ? value.operation
      : value.action;

  if (
    action !== "READ" &&
    action !== "CREATE" &&
    action !== "MODIFY" &&
    action !== "COPY" &&
    action !== "MOVE" &&
    action !== "RENAME" &&
    action !== "DELETE"
  ) {
    return null;
  }

  if (typeof value.path !== "string") {
    return null;
  }

  return {
    action,
    path: value.path,
    destinationPath:
      typeof value.destinationPath === "string"
        ? value.destinationPath
        : undefined,
    content:
      typeof value.content === "string"
        ? value.content
        : undefined,
    expectedPreviousContentHash:
      typeof value.expectedPreviousContentHash === "string"
        ? value.expectedPreviousContentHash
        : undefined,
  };
}

function isSafeRelativeWorkspacePath(value: string): boolean {
  if (!value.trim() || [...value].some((character) => character.charCodeAt(0) < 32)) return false;
  const firstCharacter = value.charCodeAt(0);
  if (firstCharacter === 47 || firstCharacter === 92 || /^[A-Za-z]:/.test(value)) return false;
  return !value.replaceAll(String.fromCharCode(92), "/").split("/").includes("..");
}

function isWorkspaceFileOperationResult(value: unknown): value is WorkspaceFileOperationResult {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const result = value as Record<string, unknown>;
  const actions = ["READ","CREATE","MODIFY","COPY","MOVE","RENAME","DELETE"];
  return actions.includes(String(result.action)) &&
    ["COMPLETED","BLOCKED","FAILED"].includes(String(result.status)) &&
    typeof result.path === "string" &&
    (result.destinationPath === undefined || typeof result.destinationPath === "string") &&
    (result.content === undefined || typeof result.content === "string") &&
    Array.isArray(result.changedFiles) &&
    result.changedFiles.every((path) => typeof path === "string" && isSafeRelativeWorkspacePath(path)) &&
    Array.isArray(result.errors) && result.errors.every((error) => typeof error === "string");
}

function extractOperation(
  input: unknown,
): WorkspaceFileOperationRequest | null {
  if (
    typeof input !== "object" ||
    input === null
  ) {
    return null;
  }

  const value =
    input as {
      operation?: unknown;
      action?: unknown;
      path?: unknown;
      destinationPath?: unknown;
      content?: unknown;
      expectedPreviousContentHash?: unknown;
      changes?: unknown;
      fileChanges?: unknown;
    };

  const direct = normalizeOperation(
    value as Record<string, unknown>,
  );

  if (direct) {
    return direct;
  }

  const candidates =
    Array.isArray(value.changes)
      ? value.changes
      : Array.isArray(value.fileChanges)
        ? value.fileChanges
        : [];

  for (const candidate of candidates) {
    if (
      typeof candidate !== "object" ||
      candidate === null
    ) {
      continue;
    }

    const normalized =
      normalizeOperation(
        candidate as Record<string, unknown>,
      );

    if (normalized) {
      return normalized;
    }
  }

  return null;
}

/**
 * A server-owned authorizer must independently validate a persisted approval
 * against the authenticated actor, tenant, request, operation, and target.
 * Never implement this by trusting ExecutionRequest.approved.
 */
export interface FileMutationAuthorizer {
  authorize(
    request: ExecutionRequest,
    operation: WorkspaceFileOperationRequest,
  ): Promise<boolean>;
}

/**
 * FILE READs require an independently scoped server-side authorization
 * decision. This must validate the authenticated session, tenant membership,
 * and server-resolved workspace/path scope; targetReference is not authority.
 */
export interface FileReadAuthorizer {
  authorizeRead(
    request: ExecutionRequest,
    operation: WorkspaceFileOperationRequest,
  ): Promise<boolean>;
}

export class FileExecutionAdapter
  implements ExecutionAdapter
{
  public readonly capability = "FILE" as const;

  constructor(
    /**
     * Must be an explicitly provisioned, tenant-bound workspace executor.
     * Never default to process.cwd(): that would make the application/repository
     * directory an implicit user workspace.
     */
    private readonly executor?: WorkspaceFileExecutor,
    private readonly mutationAuthorizer?: FileMutationAuthorizer,
    private readonly readAuthorizer?: FileReadAuthorizer,
  ) {}

  status(): AdapterStatus {
    return this.executor ? "AVAILABLE" : "NOT_YET_CONNECTED";
  }

  canExecute(
    request: ExecutionRequest,
  ): boolean {
    return (
      request.capability === "FILE" &&
      request.targetReference?.entityType === "FILE" &&
      [
        "READ",
        "CREATE",
        "MODIFY",
        "COPY",
        "MOVE",
        "RENAME",
        "DELETE",
      ].includes(request.action)
    );
  }

  async execute(
    request: ExecutionRequest,
  ): Promise<ExecutionResult> {
    const startedAt =
      new Date().toISOString();

    // FILE mutation authorization is decided exclusively by the injected
    // server-side persisted-grant authorizer below. The caller-controlled
    // requiresApproval/approved booleans are not proof and must not block a
    // valid one-time grant or authorize a mutation by themselves.

    if (!this.canExecute(request)) {
      return {
        ...baseResult(
          request,
          "BLOCKED",
          startedAt,
        ),
        error:
          "FILE adapter rejected the request.",
      };
    }

    const operation =
      extractOperation(request.input);

    if (!operation) {
      return {
        ...baseResult(
          request,
          "BLOCKED",
          startedAt,
        ),
        error:
          "No valid file operation was supplied.",
      };
    }

    // Do not let a remote provider weaken the relative-path contract that
    // the local executor enforces itself.
    if (!isSafeRelativeWorkspacePath(operation.path) ||
        (operation.destinationPath !== undefined &&
          !isSafeRelativeWorkspacePath(operation.destinationPath))) {
      return {
        ...baseResult(request, "BLOCKED", startedAt),
        error: "Workspace operation paths must remain inside the tenant workspace.",
      };
    }

    // Do not consume a one-time approval grant when there is no explicitly
    // provisioned workspace root to execute against. The adapter remains
    // disconnected until trusted runtime composition supplies one.
    if (!this.executor) {
      return {
        ...baseResult(request, "NOT_YET_CONNECTED", startedAt),
        error: "FILE execution requires an explicitly provisioned tenant workspace executor.",
      };
    }

    let authorized = false;
    try {
      authorized = operation.action === "READ"
        ? this.readAuthorizer !== undefined &&
          await this.readAuthorizer.authorizeRead(request, operation)
        : this.mutationAuthorizer !== undefined &&
          await this.mutationAuthorizer.authorize(request, operation);
    } catch {
      // Both read and mutation authorization failures must fail closed.
      authorized = false;
    }

    if (!authorized) {
      return {
        ...baseResult(
          request,
          operation.action === "READ" ? "BLOCKED" : "WAITING_APPROVAL",
          startedAt,
        ),
        error: operation.action === "READ"
          ? "File READ requires a server-verified scoped read authorizer."
          : "File mutation requires a server-verified approval authorizer.",
      };
    }

    let result: WorkspaceFileOperationResult;
    try {
      const candidate: unknown = await this.executor.executeOperation(operation);
      if (!isWorkspaceFileOperationResult(candidate) ||
          candidate.action !== operation.action ||
          candidate.path !== operation.path ||
          (operation.destinationPath !== undefined &&
            candidate.destinationPath !== operation.destinationPath) ||
          (operation.action === "READ" && typeof candidate.content !== "string")) {
        return {
          ...baseResult(request, "FAILED", startedAt),
          error: "Tenant workspace executor returned an invalid or mismatched operation result.",
        };
      }
      result = candidate;
    } catch {
      return {
        ...baseResult(request, "FAILED", startedAt),
        error: "Tenant workspace executor failed.",
      };
    }

    if (result.status !== "COMPLETED") {
      return {
        ...baseResult(
          request,
          result.status === "BLOCKED"
            ? "BLOCKED"
            : "FAILED",
          startedAt,
        ),
        output: {
          mode:
            "SAFE_FILE_EXECUTION",
          operation:
            result.action,
          entityType:
            request.targetReference?.entityType,
          entityId:
            request.targetReference?.entityId,
          changedFiles:
            result.changedFiles,
          shellExecuted:
            false,
        },
        error: "Tenant workspace operation did not complete.",
      };
    }

    return {
      ...baseResult(
        request,
        "COMPLETED",
        startedAt,
      ),
      output: {
        mode:
          "SAFE_FILE_EXECUTION",
        operation:
          result.action,
        entityType:
          request.targetReference?.entityType,
        entityId:
          request.targetReference?.entityId,
        path:
          result.path,
        destinationPath:
          result.destinationPath,
        content:
          result.content,
        changedFiles:
          result.changedFiles,
        shellExecuted:
          false,
      },
    };
  }
}
