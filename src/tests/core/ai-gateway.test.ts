import { AIGateway } from "@/core/ai/gateway";
import { AIProviderRegistry } from "@/core/ai/provider-registry";

async function main(): Promise<void> {
  const registry = new AIProviderRegistry();
  const gateway = new AIGateway(registry);

  const providers = registry.list();

  if (providers.length !== 5) {
    throw new Error(
      `Expected 5 AI providers, received ${providers.length}.`,
    );
  }

  const gemini = registry.get("GEMINI");

  if (gemini.status !== "NOT_YET_CONNECTED") {
    throw new Error(
      "Gemini must not be reported as connected before configuration.",
    );
  }

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
    providers: providers.length,
    gemini: gemini.status,
    fakeResponsePrevented: true,
    requestIdGenerated: true,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
