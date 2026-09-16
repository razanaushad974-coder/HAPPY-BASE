import type {
  AdapterStatus,
  ExecutionAdapter,
  ExecutionRequest,
  ExecutionResult,
} from "./types";

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

function extractCommand(
  input: unknown,
): string {
  if (
    typeof input === "object" &&
    input !== null &&
    "command" in input
  ) {
    const value =
      (input as { command?: unknown }).command;

    if (typeof value === "string") {
      return value;
    }
  }

  return "";
}

export class CodeExecutionAdapter
  implements ExecutionAdapter
{
  public readonly capability = "CODE" as const;

  status(): AdapterStatus {
    /*
     * CODE capability is connected at the planning/
     * execution-contract level, but arbitrary workspace
     * mutation and shell execution remain blocked until
     * the safe workspace executor is connected.
     */
    return "NOT_YET_CONNECTED";
  }

  canExecute(
    request: ExecutionRequest,
  ): boolean {
    return (
      request.capability === "CODE" &&
      [
        "CREATE",
        "MODIFY",
        "BUILD",
        "TEST",
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

    const command =
      extractCommand(request.input);

    return {
      ...baseResult(
        request,
        "NOT_YET_CONNECTED",
        startedAt,
      ),
      output: {
        mode:
          "SAFE_CODE_EXECUTION_CONTRACT",
        action:
          request.action,
        command,
        targetReference:
          request.targetReference,
        executionBlocked:
          true,
        reason:
          "Workspace code executor is not connected. No files or shell commands were executed.",
      },
      error:
        "CODE execution adapter is not yet connected to a real workspace executor.",
    };
  }
}
