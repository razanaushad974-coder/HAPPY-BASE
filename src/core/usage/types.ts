export type UsageProvider =
    | "GEMINI"
    | "GROQ"
    | "OPENAI"
    | "ANTHROPIC"
    | "LOCAL"
    | "SYSTEM"
    | "BROWSER"
    | "FILE"
    | "STORAGE"
    | "IMAGE"
    | "VIDEO"
    | "AUDIO"
    | "API"
    | "AUTOMATION";

export type UsageUnit =
    | "REQUEST"
    | "TOKEN"
    | "INPUT_TOKEN"
    | "OUTPUT_TOKEN"
    | "IMAGE"
    | "VIDEO_SECOND"
    | "AUDIO_SECOND"
    | "BYTE"
    | "API_CALL"
    | "BROWSER_ACTION"
    | "AUTOMATION_RUN";

export type UsageStatus =
    | "RECORDED"
    | "ESTIMATED"
    | "FINAL"
    | "FAILED"
    | "REJECTED";

export interface UsageRecord {
    id: string;
    userId?: string;
    organizationId: string;
    workspaceId: string;
    projectId?: string;
    missionId?: string;
    taskId?: string;
    requestId?: string;

    provider: UsageProvider;
    model?: string;
    unit: UsageUnit;
    quantity: number;

    inputTokens?: number;
    outputTokens?: number;
    totalTokens?: number;

    estimatedCostUsd: number;
    actualCostUsd?: number;

    status: UsageStatus;
    metadata?: Record<string, unknown>;

    createdAt: string;
}

export interface UsageSummary {
    records: number;
    totalQuantity: number;
    inputTokens: number;
    outputTokens: number;
    totalTokens: number;
    estimatedCostUsd: number;
    actualCostUsd: number;
}

export interface UsageLimit {
    id: string;
    organizationId: string;
    workspaceId: string;
    userId?: string;

    unit: UsageUnit;
    limit: number;
    used: number;

    period: "REQUEST" | "DAY" | "MONTH" | "LIFETIME";
    enabled: boolean;
}

export interface CostRate {
    provider: UsageProvider;
    model?: string;
    unit: UsageUnit;

    inputPerMillionTokensUsd?: number;
    outputPerMillionTokensUsd?: number;
    perUnitUsd?: number;
}

export interface UsageLedgerEntry {
    usageId: string;
    debitUsd: number;
    creditUsd: number;
    balanceUsd: number;
    createdAt: string;
}
