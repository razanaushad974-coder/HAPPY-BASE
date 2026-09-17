import type {
  AdapterStatus,
  ExecutionAdapter,
  ExecutionRequest,
  ExecutionResult,
} from "./types";

export type DatabaseAction =
  | "DB_SELECT"
  | "DB_QUERY"
  | "DB_INSERT"
  | "DB_UPDATE"
  | "DB_DELETE"
  | "DB_TRANSACTION";

export type DatabaseTenantScope = {
  organizationId: string;
  workspaceId: string;
  userId?: string;
};

export type DatabaseExecutionInput = {
  action: DatabaseAction;
  resource: string;
  scope: DatabaseTenantScope;
  filter?: Record<string, unknown>;
  values?: Record<string, unknown>;
  limit?: number;
  transaction?: Array<{
    action: Exclude<DatabaseAction, "DB_TRANSACTION">;
    resource: string;
    filter?: Record<string, unknown>;
    values?: Record<string, unknown>;
  }>;
};

export interface DatabaseProvider {
  status(): AdapterStatus;
  execute(
    input: DatabaseExecutionInput,
  ): Promise<unknown>;
}

const WRITE_ACTIONS = new Set<DatabaseAction>([
  "DB_INSERT",
  "DB_UPDATE",
  "DB_DELETE",
  "DB_TRANSACTION",
]);

function now(): string {
  return new Date().toISOString();
}

function result(
  request: ExecutionRequest,
  status: ExecutionResult["status"],
  startedAt: string,
  output?: unknown,
  error?: string,
): ExecutionResult {
  return {
    id: crypto.randomUUID(),
    requestId: request.id,
    capability: "DATABASE",
    status,
    output,
    error,
    evidenceIds: [],
    startedAt,
    completedAt: now(),
  };
}

function parseInput(
  value: unknown,
): DatabaseExecutionInput | undefined {
  if (!value || typeof value !== "object") {
    return undefined;
  }

  const input = value as Partial<DatabaseExecutionInput>;

  if (
    input.action !== "DB_SELECT" &&
    input.action !== "DB_QUERY" &&
    input.action !== "DB_INSERT" &&
    input.action !== "DB_UPDATE" &&
    input.action !== "DB_DELETE" &&
    input.action !== "DB_TRANSACTION"
  ) {
    return undefined;
  }

  if (
    typeof input.resource !== "string" ||
    !input.resource.trim()
  ) {
    return undefined;
  }

  if (!input.scope || typeof input.scope !== "object") {
    return undefined;
  }

  const scope = input.scope as Partial<DatabaseTenantScope>;

  if (
    typeof scope.organizationId !== "string" ||
    !scope.organizationId.trim() ||
    typeof scope.workspaceId !== "string" ||
    !scope.workspaceId.trim()
  ) {
    return undefined;
  }

  return input as DatabaseExecutionInput;
}

export class DatabaseExecutionAdapter
  implements ExecutionAdapter
{
  readonly capability = "DATABASE" as const;

  constructor(
    private readonly provider?: DatabaseProvider,
  ) {}

  status(): AdapterStatus {
    if (!this.provider) {
      return "NOT_YET_CONNECTED";
    }

    return this.provider.status();
  }

  canExecute(
    request: ExecutionRequest,
  ): boolean {
    const input = parseInput(request.input);

    if (!input) {
      return false;
    }

    if (
      input.action === "DB_TRANSACTION" &&
      (!Array.isArray(input.transaction) ||
        input.transaction.length === 0)
    ) {
      return false;
    }

    return true;
  }

  async execute(
    request: ExecutionRequest,
  ): Promise<ExecutionResult> {
    const startedAt = now();
    const input = parseInput(request.input);

    if (!input) {
      return result(
        request,
        "BLOCKED",
        startedAt,
        undefined,
        "Invalid DATABASE execution input.",
      );
    }

    if (
      WRITE_ACTIONS.has(input.action) &&
      request.requiresApproval &&
      !request.approved
    ) {
      return result(
        request,
        "WAITING_APPROVAL",
        startedAt,
        undefined,
        "Database write execution requires explicit approval.",
      );
    }

    if (!this.provider) {
      return result(
        request,
        "NOT_YET_CONNECTED",
        startedAt,
        undefined,
        "DATABASE provider is not connected.",
      );
    }

    if (this.provider.status() !== "AVAILABLE") {
      return result(
        request,
        "NOT_YET_CONNECTED",
        startedAt,
        undefined,
        `DATABASE provider is ${this.provider.status()}.`,
      );
    }

    try {
      const output =
        await this.provider.execute(input);

      return result(
        request,
        "COMPLETED",
        startedAt,
        output,
      );
    } catch (error: unknown) {
      return result(
        request,
        "FAILED",
        startedAt,
        undefined,
        error instanceof Error
          ? error.message
          : String(error),
      );
    }
  }
}
