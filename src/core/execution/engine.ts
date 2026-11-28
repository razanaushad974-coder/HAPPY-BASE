import type {
  ExecutionRequest,
  ExecutionResult,
} from "./types";

import { ExecutionAdapterRegistry } from "./registry";

const APPROVAL_REQUIRED_ACTIONS = new Set([
  "POST", "PUT", "PATCH", "DELETE", "DEPLOY", "PUBLISH", "CONTROL",
  "DB_INSERT", "DB_UPDATE", "DB_DELETE", "DB_TRANSACTION",
]);

function requiresExecutionApproval(request: ExecutionRequest): boolean {
  const action = request.action.trim().toUpperCase().replace(/[\\s-]+/g, "_");
  return request.requiresApproval ||
    request.risk !== "LOW" ||
    APPROVAL_REQUIRED_ACTIONS.has(action);
}

export class ExecutionEngine {
  constructor(
    private readonly registry: ExecutionAdapterRegistry,
  ) {}

  async execute(
    request: ExecutionRequest,
  ): Promise<ExecutionResult> {
    const adapter = this.registry.get(
      request.capability,
    );

    if (!adapter) {
      return {
        id: crypto.randomUUID(),
        requestId: request.id,
        capability: request.capability,
        status: "NOT_YET_CONNECTED",
        error:
          `No execution adapter registered for ${request.capability}.`,
        evidenceIds: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }

    // Defense in depth: callers cannot downgrade a non-LOW risk or
    // intrinsically sensitive action by setting requiresApproval=false.
    // The orchestration boundary must still verify persisted approval;
    // request.approved is only the result propagated from that trusted check.
    if (
      requiresExecutionApproval(request) &&
      !request.approved
    ) {
      return {
        id: crypto.randomUUID(),
        requestId: request.id,
        capability: request.capability,
        status: "WAITING_APPROVAL",
        error: "Explicit approval is required.",
        evidenceIds: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }

    if (adapter.status() !== "AVAILABLE") {
      return {
        id: crypto.randomUUID(),
        requestId: request.id,
        capability: request.capability,
        status: "NOT_YET_CONNECTED",
        error:
          `${request.capability} adapter is ${adapter.status()}.`,
        evidenceIds: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }

    if (!adapter.canExecute(request)) {
      return {
        id: crypto.randomUUID(),
        requestId: request.id,
        capability: request.capability,
        status: "BLOCKED",
        error:
          "Execution adapter rejected the request.",
        evidenceIds: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    }

    return adapter.execute(request);
  }
}
