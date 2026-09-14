import type {
  AdapterStatus,
  ExecutionAdapter,
  ExecutionCapability,
  ExecutionRequest,
  ExecutionResult,
} from "./types";

export class ContractExecutionAdapter
  implements ExecutionAdapter
{
  constructor(
    public readonly capability: ExecutionCapability,
    private readonly adapterStatus: AdapterStatus =
      "NOT_YET_CONNECTED",
  ) {}

  status(): AdapterStatus {
    return this.adapterStatus;
  }

  canExecute(
    _request: ExecutionRequest,
  ): boolean {
    return this.adapterStatus === "AVAILABLE";
  }

  async execute(
    request: ExecutionRequest,
  ): Promise<ExecutionResult> {
    const startedAt = new Date().toISOString();

    if (request.requiresApproval && !request.approved) {
      return {
        id: crypto.randomUUID(),
        requestId: request.id,
        capability: request.capability,
        status: "WAITING_APPROVAL",
        error: "Execution requires explicit approval.",
        evidenceIds: [],
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }

    if (this.adapterStatus !== "AVAILABLE") {
      return {
        id: crypto.randomUUID(),
        requestId: request.id,
        capability: request.capability,
        status: "NOT_YET_CONNECTED",
        error:
          `${request.capability} execution adapter is not connected.`,
        evidenceIds: [],
        startedAt,
        completedAt: new Date().toISOString(),
      };
    }

    return {
      id: crypto.randomUUID(),
      requestId: request.id,
      capability: request.capability,
      status: "COMPLETED",
      output: {
        mode: "CONTRACT_EXECUTION",
        action: request.action,
        inputAccepted: true,
      },
      evidenceIds: [],
      startedAt,
      completedAt: new Date().toISOString(),
    };
  }
}
