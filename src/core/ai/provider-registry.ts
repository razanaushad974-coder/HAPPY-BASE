import type {
  AIProvider,
  AIProviderInfo,
} from "./types";

/**
 * Provider registry.
 *
 * This registry reports configuration state only.
 * It never pretends a provider is connected.
 */

const providers: AIProviderInfo[] = [
  {
    provider: "GEMINI",
    status: "NOT_YET_CONNECTED",
  },
  {
    provider: "GROQ",
    status: "NOT_YET_CONNECTED",
  },
  {
    provider: "OPENAI",
    status: "NOT_YET_CONNECTED",
  },
  {
    provider: "ANTHROPIC",
    status: "NOT_YET_CONNECTED",
  },
  {
    provider: "LOCAL",
    status: "NOT_YET_CONNECTED",
  },
];

export class AIProviderRegistry {
  list(): AIProviderInfo[] {
    return [...providers];
  }

  get(provider: AIProvider): AIProviderInfo {
    const found = providers.find(
      (item) => item.provider === provider,
    );

    if (!found) {
      throw new Error(`Unknown AI provider: ${provider}`);
    }

    return { ...found };
  }

  isConnected(provider: AIProvider): boolean {
    return this.get(provider).status === "CONNECTED";
  }
}
