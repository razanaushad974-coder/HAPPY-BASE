import { GoogleGenAI } from "@google/genai";
import type {
  AIRequest,
  AIResponse,
} from "./types";

export interface GeminiAdapterOptions {
  apiKey?: string;
  defaultModel?: string;
}

export class GeminiAdapter {
  constructor(
    private readonly options: GeminiAdapterOptions = {},
  ) {}

  private resolveApiKey(): string | undefined {
    const injected = this.options.apiKey?.trim();

    if (injected) {
      return injected;
    }

    const envKey =
      process.env.GEMINI_API_KEY?.trim();

    return envKey || undefined;
  }

  private resolveModel(
    request: AIRequest,
  ): string {
    return (
      request.model?.trim() ||
      this.options.defaultModel?.trim() ||
      process.env.GEMINI_MODEL?.trim() ||
      "gemini-2.5-flash"
    );
  }

  private buildContents(request: AIRequest) {
    return request.messages
      .filter(
        (message) =>
          message.role !== "system",
      )
      .map((message) => ({
        role:
          message.role === "assistant"
            ? "model"
            : "user",
        parts: [
          {
            text: message.content,
          },
        ],
      }));
  }

  private resolveSystemInstruction(
    request: AIRequest,
  ): string | undefined {
    const systemMessages = request.messages
      .filter(
        (message) =>
          message.role === "system",
      )
      .map((message) =>
        message.content.trim(),
      )
      .filter(Boolean);

    if (systemMessages.length === 0) {
      return undefined;
    }

    return systemMessages.join("\n\n");
  }

  isConfigured(): boolean {
    return (
      this.resolveApiKey() !== undefined
    );
  }

  async complete(
    request: AIRequest,
    requestId: string,
  ): Promise<AIResponse> {
    const apiKey =
      this.resolveApiKey();

    const model =
      this.resolveModel(request);

    if (!apiKey) {
      return {
        success: false,
        provider: "GEMINI",
        model,
        requestId,
        status: "NOT_YET_CONNECTED",
        errorCode:
          "GEMINI_API_KEY_MISSING",
        errorMessage:
          "GEMINI_API_KEY is not configured.",
      };
    }

    try {
      const ai = new GoogleGenAI({
        apiKey,
      });

      const response =
        await ai.models.generateContent({
          model,
          contents:
            this.buildContents(request),
          config: {
            systemInstruction:
              this.resolveSystemInstruction(
                request,
              ),
            temperature:
              request.temperature,
            maxOutputTokens:
              request.maxTokens,
          },
        });

      const usage =
        response.usageMetadata;

      return {
        success: true,
        provider: "GEMINI",
        model,
        content: response.text ?? "",
        usage: {
          inputTokens:
            usage?.promptTokenCount,
          outputTokens:
            usage?.candidatesTokenCount,
          totalTokens:
            usage?.totalTokenCount,
        },
        requestId,
        status: "COMPLETED",
      };
    } catch (error: unknown) {
      const message =
        error instanceof Error
          ? error.message
          : String(error);

      return {
        success: false,
        provider: "GEMINI",
        model,
        requestId,
        status: "FAILED",
        errorCode:
          "GEMINI_REQUEST_FAILED",
        errorMessage: message,
      };
    }
  }
}
