import { AIGateway } from "@/core/ai/gateway";
import type { AIProviderRegistry } from "@/core/ai/provider-registry";

async function main(): Promise<void> {
  /*
   * This regression test must remain deterministic even when a real
   * Gemini API key is configured in the developer environment.
   */
  const disconnectedRegistry = {
    list: () => [],
    get: () => ({
      provider: "GEMINI" as const,
      status: "NOT_YET_CONNECTED" as const,
      defaultModel: "gemini-3.6-flash",
    }),
    isConnected: () => false,
  } as unknown as AIProviderRegistry;

  const gateway = new AIGateway(disconnectedRegistry);

  const response = await gateway.complete({
    provider: "GEMINI",
    mode: "UNDERSTAND",
    messages: [
      {
        role: "user",
        content: "Hello HAPPY",
      },
    ],
  });

  if (response.success) {
    throw new Error(
      "Gateway must not fake an AI response when provider is unavailable.",
    );
  }

  if (response.status !== "NOT_YET_CONNECTED") {
    throw new Error(
      "Unavailable provider must return NOT_YET_CONNECTED.",
    );
  }

  if (response.errorCode !== "AI_PROVIDER_NOT_CONNECTED") {
    throw new Error(
      "Unexpected unavailable-provider error code.",
    );
  }

  if (!response.requestId.startsWith("ai_")) {
    throw new Error(
      "AI request ID was not generated correctly.",
    );
  }

  console.log("AI gateway test: PASS");

  console.log({
    provider: response.provider,
    status: response.status,
    fakeResponsePrevented: true,
    requestIdGenerated: true,
    deterministicWithoutEnvironmentDependency: true,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
