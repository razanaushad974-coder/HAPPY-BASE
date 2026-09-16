import type {
  AIProvider,
  AIProviderInfo,
} from "./types";

export interface AIProviderRegistryOptions {
  geminiApiKey?: string;
  geminiModel?: string;
}

function configuredGeminiKey(
  options?: AIProviderRegistryOptions,
): string | undefined {
  return (
    options?.geminiApiKey?.trim() ||
    process.env.GEMINI_API_KEY?.trim() ||
    undefined
  );
}

function configuredGeminiModel(
  options?: AIProviderRegistryOptions,
): string {
  return (
    options?.geminiModel?.trim() ||
    process.env.GEMINI_MODEL?.trim() ||
    "gemini-2.5-flash"
  );
}

export class AIProviderRegistry {
  constructor(
    private readonly options: AIProviderRegistryOptions = {},
  ) {}

  list(): AIProviderInfo[] {
    return [
      this.get("GEMINI"),
      this.get("GROQ"),
      this.get("OPENAI"),
      this.get("ANTHROPIC"),
      this.get("LOCAL"),
    ];
  }

  get(
    provider: AIProvider,
  ): AIProviderInfo {
    switch (provider) {
      case "GEMINI":
        return {
          provider,
          status:
            configuredGeminiKey(
              this.options,
            )
              ? "CONNECTED"
              : "NOT_YET_CONNECTED",
          defaultModel:
            configuredGeminiModel(
              this.options,
            ),
        };

      case "GROQ":
      case "OPENAI":
      case "ANTHROPIC":
      case "LOCAL":
        return {
          provider,
          status:
            "NOT_YET_CONNECTED",
        };
    }
  }

  isConnected(
    provider: AIProvider,
  ): boolean {
    return (
      this.get(provider)
        .status === "CONNECTED"
    );
  }
}
