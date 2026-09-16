import { AIGateway } from "@/core/ai/gateway";

async function main(): Promise<void> {
  /*
   * Regression test intentionally uses a provider that is not configured.
   * This keeps the test deterministic even when Gemini is live.
   */
  const gateway = new AIGateway();

  const response = await gateway.complete({
    provider: "GROQ",
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
      "Gateway must not fake an AI response for an unavailable provider.",
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
    deterministicWithLiveGemini: true,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
