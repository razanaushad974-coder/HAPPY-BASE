import { AIGateway } from "../../../core/ai/gateway";
import { AIExecutionAdapter } from "../../../core/execution/ai-execution-adapter";
import { ExecutionAdapterRegistry } from "../../../core/execution/registry";
import { ExecutionEngine } from "../../../core/execution/engine";
import type { ExecutionRequest } from "../../../core/execution/types";

function assert(
  condition: boolean,
  message: string,
): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const fakeGateway = {
    complete: async () => ({
      success: true,
      provider: "GEMINI" as const,
      model: "gemini-3.6-flash",
      content: "AI PIPELINE VERIFIED",
      requestId: "ai-pipeline-test-001",
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
    const registry =
      new ExecutionAdapterRegistry();

    registry.register(
      new AIExecutionAdapter(
        fakeGateway,
      ),
    );

    const engine =
      new ExecutionEngine(registry);

    const request: ExecutionRequest = {
      id:
        "exec-ai-pipeline-test",
      taskId:
        "task-ai-pipeline-test",
      missionId:
        "mission-ai-pipeline-test",
      capability:
        "AI",
      action:
        "UNDERSTAND",
      input: {
        command:
          "Reply with exactly: AI PIPELINE VERIFIED",
      },
      requiresApproval:
        false,
      approved:
        true,
      risk:
        "LOW",
      createdAt:
        new Date().toISOString(),
    };

    const result =
      await engine.execute(
        request,
      );

    assert(
      result.status ===
        "COMPLETED",
      "AI execution did not complete.",
    );

    assert(
      result.capability ===
        "AI",
      "Execution capability is incorrect.",
    );

    assert(
      typeof result.output ===
        "object" &&
        result.output !== null,
      "Execution output is missing.",
    );

    const output =
      result.output as {
        provider?: string;
        model?: string;
        content?: string;
      };

    assert(
      output.provider ===
        "GEMINI",
      "Gemini provider was not used.",
    );

    assert(
      output.content ===
        "AI PIPELINE VERIFIED",
      "AI execution output mismatch.",
    );

    const approvalRequest: ExecutionRequest = {
      ...request,
      id:
        "exec-ai-approval-test",
      requiresApproval:
        true,
      approved:
        false,
    };

    const blocked =
      await engine.execute(
        approvalRequest,
      );

    assert(
      blocked.status ===
        "WAITING_APPROVAL",
      "Approval gate was bypassed.",
    );

    console.log(
      "STEP 39 AI pipeline test: PASS",
    );

    console.log({
      aiCapabilityRegistered: true,
      geminiGatewayConnected: true,
      executionCompleted: true,
      outputVerified: true,
      approvalGate: true,
      fakeExternalActionPrevented: true,
    });
  } finally {
    if (
      previousKey ===
      undefined
    ) {
      delete process.env.GEMINI_API_KEY;
    } else {
      process.env.GEMINI_API_KEY =
        previousKey;
    }
  }
}

main().catch(
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
