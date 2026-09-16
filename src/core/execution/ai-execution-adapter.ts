import { AIGateway } from "../ai/gateway";
import type { AIRequestMode } from "../ai/types";
import type {
  AdapterStatus,
  ExecutionAdapter,
  ExecutionRequest,
  ExecutionResult,
} from "./types";

function createResultBase(
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

function resolveMode(
  action: string,
): AIRequestMode {
  switch (action) {
    case "RESEARCH":
      return "UNDERSTAND";

    case "CONTROL":
      return "REASON";

    case "VERIFY":
      return "UNDERSTAND";

    case "UNDERSTAND":
    default:
      return "UNDERSTAND";
  }
}

export class AIExecutionAdapter
  implements ExecutionAdapter
{
  public readonly capability = "AI" as const;

  constructor(
    private readonly gateway: AIGateway =
      new AIGateway(),
  ) {}

  status(): AdapterStatus {
    return process.env.GEMINI_API_KEY?.trim()
      ? "AVAILABLE"
      : "NOT_YET_CONNECTED";
  }

  canExecute(
    request: ExecutionRequest,
  ): boolean {
    return (
      request.capability === "AI" &&
      [
        "UNDERSTAND",
        "RESEARCH",
        "VERIFY",
        "CONTROL",
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
        ...createResultBase(
          request,
          "WAITING_APPROVAL",
          startedAt,
        ),
        error:
          "Execution requires explicit approval.",
      };
    }

    if (this.status() !== "AVAILABLE") {
      return {
        ...createResultBase(
          request,
          "NOT_YET_CONNECTED",
          startedAt,
        ),
        error:
          "Gemini-backed AI execution is not connected.",
      };
    }

    if (!this.canExecute(request)) {
      return {
        ...createResultBase(
          request,
          "BLOCKED",
          startedAt,
        ),
        error:
          `AI execution does not support action ${request.action}.`,
      };
    }

    const input =
      typeof request.input === "object" &&
      request.input !== null
        ? request.input
        : {
            value: request.input,
          };

    const command =
      "command" in input &&
      typeof input.command === "string"
        ? input.command
        : JSON.stringify(input);

    const response =
      await this.gateway.complete({
        provider: "GEMINI",
        mode: resolveMode(request.action),
        messages: [
          {
            role: "system",
            content:
              "You are HAPPY AI's execution capability. Execute only the requested AI-level reasoning task. Do not claim external actions were completed.",
          },
          {
            role: "user",
            content: command,
          },
        ],
        temperature: 0.2,
        maxTokens: 2000,
      });

    if (
      response.status ===
      "NOT_YET_CONNECTED"
    ) {
      return {
        ...createResultBase(
          request,
          "NOT_YET_CONNECTED",
          startedAt,
        ),
        error:
          response.errorMessage ??
          "AI provider is not connected.",
      };
    }

    if (!response.success) {
      return {
        ...createResultBase(
          request,
          "FAILED",
          startedAt,
        ),
        error:
          response.errorMessage ??
          "AI execution failed.",
      };
    }

    return {
      ...createResultBase(
        request,
        "COMPLETED",
        startedAt,
      ),
      output: {
        provider: response.provider,
        model: response.model,
        content: response.content ?? "",
        usage: response.usage,
      },
    };
  }
}
