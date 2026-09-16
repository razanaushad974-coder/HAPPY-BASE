import type {
  AdapterStatus,
  ExecutionAdapter,
  ExecutionRequest,
  ExecutionResult,
} from "./types";

import {
  WorkspaceCodeExecutor,
  type WorkspaceFileOperationRequest,
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

export class FileExecutionAdapter
  implements ExecutionAdapter
{
  public readonly capability = "FILE" as const;

  constructor(
    private readonly executor: WorkspaceCodeExecutor =
      new WorkspaceCodeExecutor(),
  ) {}

  status(): AdapterStatus {
    return "AVAILABLE";
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

    if (
      request.requiresApproval &&
      !request.approved
    ) {
      return {
        ...baseResult(
          request,
          "WAITING_APPROVAL",
          startedAt,
        ),
        error:
          "File execution requires explicit approval.",
      };
    }

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

    const result =
      this.executor.executeOperation(
        operation,
      );

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
        error:
          result.errors.join("; ") ||
          "File execution failed.",
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
