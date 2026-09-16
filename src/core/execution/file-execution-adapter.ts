import type {
  AdapterStatus,
  ExecutionAdapter,
  ExecutionRequest,
  ExecutionResult,
} from "./types";

import {
  WorkspaceCodeExecutor,
  type WorkspaceFileChange,
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

function extractChanges(
  input: unknown,
): WorkspaceFileChange[] {
  if (
    typeof input !== "object" ||
    input === null
  ) {
    return [];
  }

  const value =
    input as {
      changes?: unknown;
      fileChanges?: unknown;
    };

  const raw =
    Array.isArray(value.changes)
      ? value.changes
      : Array.isArray(value.fileChanges)
        ? value.fileChanges
        : [];

  return raw.filter(
    (
      item,
    ): item is WorkspaceFileChange =>
      typeof item === "object" &&
      item !== null &&
      (
        item as {
          action?: unknown;
        }
      ).action !== undefined &&
      (
        item as {
          action?: unknown;
        }
      ).action !== "DELETE" &&
      (
        item as {
          action?: unknown;
        }
      ).action !== "RENAME" &&
      (
        item as {
          action?: unknown;
        }
      ).action !== "MOVE" &&
      (
        item as {
          action?: unknown;
        }
      ).action !== "COPY" &&
      (
        item as {
          action?: unknown;
        }
      ).action !== "READ" &&
      typeof (
        item as {
          path?: unknown;
        }
      ).path === "string" &&
      typeof (
        item as {
          content?: unknown;
        }
      ).content === "string",
  ) as WorkspaceFileChange[];
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
      (
        request.action === "CREATE" ||
        request.action === "MODIFY"
      ) &&
      request.targetReference?.entityType === "FILE"
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

    const changes =
      extractChanges(request.input);

    if (changes.length === 0) {
      return {
        ...baseResult(
          request,
          "BLOCKED",
          startedAt,
        ),
        error:
          "No safe file changes were supplied.",
      };
    }

    const result =
      this.executor.execute(changes);

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
        entityType:
          request.targetReference?.entityType,
        entityId:
          request.targetReference?.entityId,
        changedFiles:
          result.changedFiles,
        shellExecuted:
          false,
      },
    };
  }
}
