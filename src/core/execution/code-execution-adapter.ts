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

function extractInput(
  input: unknown,
): {
  command: string;
  changes: WorkspaceFileChange[];
} {
  if (
    typeof input !== "object" ||
    input === null
  ) {
    return {
      command: "",
      changes: [],
    };
  }

  const value =
    input as {
      command?: unknown;
      changes?: unknown;
      fileChanges?: unknown;
    };

  const command =
    typeof value.command === "string"
      ? value.command
      : "";

  const rawChanges =
    Array.isArray(value.changes)
      ? value.changes
      : Array.isArray(value.fileChanges)
        ? value.fileChanges
        : [];

  const changes: WorkspaceFileChange[] =
    rawChanges.filter(
      (
        item,
      ): item is WorkspaceFileChange =>
        typeof item === "object" &&
        item !== null &&
        typeof (
          item as {
            action?: unknown;
          }
        ).action === "string" &&
        (
          item as {
            action?: unknown;
          }
        ).action !== "DELETE" &&
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

  return {
    command,
    changes,
  };
}

export class CodeExecutionAdapter
  implements ExecutionAdapter
{
  public readonly capability = "CODE" as const;

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
      request.capability === "CODE" &&
      [
        "CREATE",
        "MODIFY",
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
          "Code execution requires explicit approval.",
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
          `CODE capability does not support action ${request.action}.`,
      };
    }

    const input =
      extractInput(request.input);

    if (input.changes.length === 0) {
      return {
        ...baseResult(
          request,
          "BLOCKED",
          startedAt,
        ),
        output: {
          mode:
            "SAFE_CODE_EXECUTION",
          action:
            request.action,
          command:
            input.command,
          targetReference:
            request.targetReference,
          executionStarted:
            false,
        },
        error:
          "No approved workspace file changes were supplied.",
      };
    }

    const result =
      this.executor.execute(
        input.changes,
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
            "SAFE_CODE_EXECUTION",
          action:
            request.action,
          changedFiles:
            result.changedFiles,
          executionStarted:
            result.changedFiles.length > 0,
        },
        error:
          result.errors.join("; ") ||
          "Workspace code execution failed.",
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
          "SAFE_CODE_EXECUTION",
        action:
          request.action,
        changedFiles:
          result.changedFiles,
        command:
          input.command,
        targetReference:
          request.targetReference,
        executionStarted:
          true,
        shellExecuted:
          false,
      },
    };
  }
}
