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

const MUTATING_FILE_ACTIONS = new Set([
  "CREATE", "MODIFY", "COPY", "MOVE", "RENAME", "DELETE",
]);

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
  const action = typeof value.operation === "string" ? value.operation : value.action;
  if (
    action !== "READ" && action !== "CREATE" && action !== "MODIFY" &&
    action !== "COPY" && action !== "MOVE" && action !== "RENAME" &&
    action !== "DELETE"
  ) return null;
  if (typeof value.path !== "string" || !value.path.trim()) return null;

  return {
    action,
    path: value.path,
    destinationPath: typeof value.destinationPath === "string" ? value.destinationPath : undefined,
    content: typeof value.content === "string" ? value.content : undefined,
    expectedPreviousContentHash:
      typeof value.expectedPreviousContentHash === "string"
        ? value.expectedPreviousContentHash
        : undefined,
  };
}

function extractOperations(input: unknown): WorkspaceFileOperationRequest[] | null {
  if (typeof input !== "object" || input === null) return null;
  const value = input as Record<string, unknown>;
  const direct = normalizeOperation(value);
  if (direct) return [direct];

  const candidates = Array.isArray(value.changes)
    ? value.changes
    : Array.isArray(value.fileChanges)
      ? value.fileChanges
      : null;
  if (!candidates || candidates.length === 0) return null;

  const operations: WorkspaceFileOperationRequest[] = [];
  for (const candidate of candidates) {
    if (typeof candidate !== "object" || candidate === null) return null;
    const normalized = normalizeOperation(candidate as Record<string, unknown>);
    if (!normalized) return null;
    operations.push(normalized);
  }
  return operations;
}

export class FileExecutionAdapter implements ExecutionAdapter {
  public readonly capability = "FILE" as const;

  constructor(
    private readonly executor: WorkspaceCodeExecutor = new WorkspaceCodeExecutor(),
  ) {}

  status(): AdapterStatus {
    return "AVAILABLE";
  }

  canExecute(request: ExecutionRequest): boolean {
    return (
      request.capability === "FILE" &&
      request.targetReference?.entityType === "FILE" &&
      ["READ", "CREATE", "MODIFY", "COPY", "MOVE", "RENAME", "DELETE"].includes(request.action)
    );
  }

  async execute(request: ExecutionRequest): Promise<ExecutionResult> {
    const startedAt = new Date().toISOString();

    if (!this.canExecute(request)) {
      return {
        ...baseResult(request, "BLOCKED", startedAt),
        error: "FILE adapter rejected the request.",
      };
    }

    const operations = extractOperations(request.input);
    if (!operations) {
      return {
        ...baseResult(request, "BLOCKED", startedAt),
        error: "No valid file operation list was supplied.",
      };
    }

    const hasMutation = operations.some((operation) =>
      MUTATING_FILE_ACTIONS.has(operation.action),
    );

    // Approval is mandatory for mutations; the planner cannot disable it by
    // setting requiresApproval=false. The approval decision must be explicit.
    if (hasMutation && (!request.requiresApproval || !request.approved)) {
      return {
        ...baseResult(request, "WAITING_APPROVAL", startedAt),
        error: "File mutations require an explicit approval decision.",
      };
    }

    const completed: WorkspaceFileOperationRequest[] = [];
    const changedFiles: string[] = [];
    const operationResults: Array<Record<string, unknown>> = [];

    for (const operation of operations) {
      const result = this.executor.executeOperation(operation);
      operationResults.push({
        action: result.action,
        path: result.path,
        destinationPath: result.destinationPath,
        status: result.status,
        content: result.content,
        errors: result.errors,
      });
      if (result.status !== "COMPLETED") {
        return {
          ...baseResult(request, result.status === "BLOCKED" ? "BLOCKED" : "FAILED", startedAt),
          output: {
            mode: "SAFE_FILE_EXECUTION",
            operations: operationResults,
            completedOperations: completed.length,
            changedFiles,
            partialExecution: completed.length > 0,
            shellExecuted: false,
          },
          error: result.errors.join("; ") || "File execution failed.",
        };
      }
      completed.push(operation);
      changedFiles.push(...result.changedFiles);
    }

    return {
      ...baseResult(request, "COMPLETED", startedAt),
      output: {
        mode: "SAFE_FILE_EXECUTION",
        operation: operations[0].action,
        path: operations[0].path,
        destinationPath: operationResults[0]?.destinationPath,
        content: operationResults[0]?.content,
        operations: operationResults,
        completedOperations: completed.length,
        changedFiles,
        partialExecution: false,
        shellExecuted: false,
      },
    };
  }
}
