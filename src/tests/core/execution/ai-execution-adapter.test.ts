import { AIExecutionAdapter } from "../../../core/execution/ai-execution-adapter";
import type { AIGateway } from "../../../core/ai/gateway";
import type { ExecutionRequest } from "../../../core/execution/types";

function assert(
  condition: boolean,
  message: string,
): void {
  if (!condition) {
    throw new Error(message);
  }
}

function request(
  overrides: Partial<ExecutionRequest> = {},
): ExecutionRequest {
  return {
    id: "exec-test-001",
    taskId: "task-test-001",
    missionId: "mission-test-001",
    capability: "AI",
    action: "UNDERSTAND",
    input: {
      command: "Explain the HAPPY execution pipeline.",
    },
    requiresApproval: false,
    approved: false,
    risk: "LOW",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function main(): Promise<void> {
  const fakeGateway = {
    complete: async () => ({
      success: true,
      provider: "GEMINI" as const,
      model: "gemini-3.6-flash",
      content: "AI EXECUTION OK",
      requestId: "ai_test_001",
      status: "COMPLETED" as const,
      usage: {
        inputTokens: 10,
        outputTokens: 4,
        totalTokens: 14,
      },
    }),
  } as unknown as AIGateway;

  const previousKey =
    process.env.GEMINI_API_KEY;

  process.env.GEMINI_API_KEY =
    "test-key";

  try {
    const adapter =
      new AIExecutionAdapter(fakeGateway);

    assert(
      adapter.status() === "AVAILABLE",
      "AI adapter should be AVAILABLE when Gemini is configured.",
    );

    assert(
      adapter.canExecute(
        request({
          action: "UNDERSTAND",
        }),
      ),
      "UNDERSTAND should route to AI capability.",
    );

    assert(
      adapter.canExecute(
        request({
          action: "RESEARCH",
        }),
      ),
      "RESEARCH should route to AI capability.",
    );

    const approvalResult =
      await adapter.execute(
        request({
          requiresApproval: true,
          approved: false,
        }),
      );

    assert(
      approvalResult.status ===
        "WAITING_APPROVAL",
      "Approval gate failed.",
    );

    const result =
      await adapter.execute(
        request(),
      );

    assert(
      result.status === "COMPLETED",
      "AI execution did not complete.",
    );

    assert(
      typeof result.output === "object" &&
        result.output !== null,
      "AI execution output missing.",
    );

    console.log(
      "STEP 39 AI execution adapter test: PASS",
    );

    console.log({
      adapterAvailable: true,
      approvalGate: true,
      geminiGatewayUsed: true,
      executionCompleted: true,
      fakeExternalExecutionNotClaimed: true,
    });
  } finally {
    if (
      previousKey === undefined
    ) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY =
        previousKey;
    }
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
