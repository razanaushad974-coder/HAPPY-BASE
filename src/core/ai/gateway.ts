import type {
  AIRequest,
  AIResponse,
  AIProvider,
} from "./types";

import { AIProviderRegistry } from "./provider-registry";

function createRequestId(): string {
  return `ai_${crypto.randomUUID()}`;
}

/**
 * Single AI boundary for HAPPY.
 *
 * Real provider adapters will be attached later.
 * Until a provider is actually configured, HAPPY
 * returns an explicit NOT_YET_CONNECTED state.
 */
export class AIGateway {
  constructor(
    private readonly registry: AIProviderRegistry =
      new AIProviderRegistry(),
  ) {}

  async complete(request: AIRequest): Promise<AIResponse> {
    const provider: AIProvider =
      request.provider ?? "GEMINI";

    const requestId = createRequestId();

    const providerInfo = this.registry.get(provider);

    if (providerInfo.status !== "CONNECTED") {
      return {
        success: false,
        provider,
        model: request.model ?? providerInfo.defaultModel,
        requestId,
        status: "NOT_YET_CONNECTED",
        errorCode: "AI_PROVIDER_NOT_CONNECTED",
        errorMessage:
          `AI provider ${provider} is not connected.`,
      };
    }

    /*
     * Real provider adapter execution will be added
     * only after an actual provider integration exists.
     */
    return {
      success: false,
      provider,
      model: request.model ?? providerInfo.defaultModel,
      requestId,
      status: "FAILED",
      errorCode: "AI_ADAPTER_NOT_IMPLEMENTED",
      errorMessage:
        `AI adapter for ${provider} is not implemented.`,
    };
  }
}
