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

/**
 * CODE is intentionally a contract-only adapter until a server-owned
 * execution service is composed. It must not write workspace files directly:
 * file mutations belong behind FileExecutionAdapter's persisted-grant gate.
 */
export class CodeExecutionAdapter
  implements ExecutionAdapter
{
  public readonly capability = "CODE" as const;

  status(): AdapterStatus {
    return "NOT_YET_CONNECTED";
  }

  canExecute(request: ExecutionRequest): boolean {
    return request.capability === "CODE";
  }

  async execute(
    request: ExecutionRequest,
  ): Promise<ExecutionResult> {
    const startedAt = new Date().toISOString();

    if (!this.canExecute(request)) {
      return {
        ...baseResult(request, "BLOCKED", startedAt),
        error: `CODE adapter cannot execute capability ${request.capability}.`,
      };
    }

    if (request.requiresApproval && !request.approved) {
      return {
        ...baseResult(request, "WAITING_APPROVAL", startedAt),
        error: "Code execution requires explicit approval.",
      };
    }

    return {
      ...baseResult(request, "NOT_YET_CONNECTED", startedAt),
      output: {
        mode: "SAFE_CODE_EXECUTION",
        action: request.action,
        targetReference: request.targetReference,
        executionStarted: false,
        shellExecuted: false,
        workspaceMutationExecuted: false,
      },
      error:
        "CODE execution is not connected. Workspace mutations must use the server-authorized FILE adapter.",
    };
  }
}
