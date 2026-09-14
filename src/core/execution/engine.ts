import type {
  ExecutionRequest,
  ExecutionResult,
} from "./types";

import { ExecutionAdapterRegistry } from "./registry";

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

    if (
      request.requiresApproval &&
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
