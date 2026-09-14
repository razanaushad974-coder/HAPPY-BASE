/**
 * HAPPY AI Gateway
 *
 * One intelligence boundary for all AI providers.
 *
 * Higher-level HAPPY modules must use this gateway
 * instead of calling providers directly.
 *
 * Provider availability is explicit.
 * No fake responses.
 */

export type AIProvider =
  | "GEMINI"
  | "GROQ"
  | "OPENAI"
  | "ANTHROPIC"
  | "LOCAL";

export type AIProviderStatus =
  | "CONNECTED"
  | "NOT_YET_CONNECTED"
  | "DISABLED"
  | "ERROR";

export type AIRequestMode =
  | "UNDERSTAND"
  | "REASON"
  | "PLAN"
  | "GENERATE"
  | "CLASSIFY"
  | "SUMMARIZE"
  | "TRANSFORM"
  | "EXTRACT";

export interface AIMessage {
  role: "system" | "user" | "assistant";
  content: string;
}

export interface AIRequest {
  provider?: AIProvider;
  model?: string;

  mode: AIRequestMode;

  messages: AIMessage[];

  temperature?: number;
  maxTokens?: number;

  metadata?: Record<string, string>;
}

export interface AIUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}

export interface AIResponse {
  success: boolean;

  provider: AIProvider;
  model?: string;

  content?: string;

  usage?: AIUsage;

  requestId: string;

  errorCode?: string;
  errorMessage?: string;

  status:
    | "COMPLETED"
    | "NOT_YET_CONNECTED"
    | "FAILED";
}

export interface AIProviderInfo {
  provider: AIProvider;
  status: AIProviderStatus;
  defaultModel?: string;
}
