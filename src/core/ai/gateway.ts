import type {
  AIRequest,
  AIResponse,
  AIProvider,
} from "./types";

import {
  AIProviderRegistry,
  type AIProviderRegistryOptions,
} from "./provider-registry";

import {
  GeminiAdapter,
  type GeminiAdapterOptions,
} from "./gemini-adapter";

function createRequestId(): string {
  return `ai_${crypto.randomUUID()}`;
}

export interface AIGatewayOptions {
  providerRegistry?: AIProviderRegistry;
  gemini?: GeminiAdapterOptions;
}

export class AIGateway {
  private readonly registry: AIProviderRegistry;
  private readonly gemini: GeminiAdapter;

  constructor(
    registryOrOptions:
      | AIProviderRegistry
      | AIGatewayOptions = {},
    legacyOptions?: AIProviderRegistryOptions,
  ) {
    if (registryOrOptions instanceof AIProviderRegistry) {
      this.registry = registryOrOptions;

      this.gemini = new GeminiAdapter({
        apiKey:
          legacyOptions?.geminiApiKey,
        defaultModel:
          legacyOptions?.geminiModel,
      });

      return;
    }

    this.registry =
      registryOrOptions.providerRegistry ??
      new AIProviderRegistry();

    this.gemini =
      new GeminiAdapter(
        registryOrOptions.gemini,
      );
  }

  async complete(
    request: AIRequest,
  ): Promise<AIResponse> {
    const provider: AIProvider =
      request.provider ?? "GEMINI";

    const requestId =
      createRequestId();

    const providerInfo =
      this.registry.get(provider);

    if (
      provider === "GEMINI" &&
      providerInfo.status === "CONNECTED"
    ) {
      return this.gemini.complete(
        request,
        requestId,
      );
    }

    if (
      providerInfo.status !==
      "CONNECTED"
    ) {
      return {
        success: false,
        provider,
        model:
          request.model ??
          providerInfo.defaultModel,
        requestId,
        status:
          "NOT_YET_CONNECTED",
        errorCode:
          "AI_PROVIDER_NOT_CONNECTED",
        errorMessage:
          `AI provider ${provider} is not connected.`,
      };
    }

    return {
      success: false,
      provider,
      model:
        request.model ??
        providerInfo.defaultModel,
      requestId,
      status: "FAILED",
      errorCode:
        "AI_ADAPTER_NOT_IMPLEMENTED",
      errorMessage:
        `AI adapter for ${provider} is not implemented.`,
    };
  }
}
