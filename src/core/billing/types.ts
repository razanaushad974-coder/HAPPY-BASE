export type BillingPlan =
    | "FREE"
    | "STARTER"
    | "PRO"
    | "BUSINESS"
    | "ENTERPRISE"
    | "CUSTOM";

export type SubscriptionStatus =
    | "TRIALING"
    | "ACTIVE"
    | "PAST_DUE"
    | "PAUSED"
    | "CANCELLED"
    | "EXPIRED";

export type BillingInterval =
    | "MONTH"
    | "YEAR"
    | "ONE_TIME";

export type PaymentStatus =
    | "PENDING"
    | "AUTHORIZED"
    | "PAID"
    | "FAILED"
    | "REFUNDED"
    | "PARTIALLY_REFUNDED"
    | "CANCELLED";

export type InvoiceStatus =
    | "DRAFT"
    | "OPEN"
    | "PAID"
    | "VOID"
    | "UNCOLLECTIBLE";

export type Entitlement =
    | "AI_CHAT"
    | "AI_REASONING"
    | "AI_BUILD"
    | "AI_CODE"
    | "AI_RESEARCH"
    | "BROWSER_AUTOMATION"
    | "FILE_PROCESSING"
    | "VOICE"
    | "DIGITAL_HUMAN"
    | "IMAGE_GENERATION"
    | "VIDEO_GENERATION"
    | "AUDIO_GENERATION"
    | "APP_BUILDER"
    | "WEBSITE_BUILDER"
    | "GAME_BUILDER"
    | "CRM"
    | "ERP"
    | "HRMS"
    | "API_ACCESS"
    | "PUBLISHING"
    | "AUTOMATION"
    | "FOUNDER_CONTROL";

export interface BillingPlanDefinition {
    id: string;
    name: BillingPlan;
    displayName: string;
    interval: BillingInterval;
    priceUsd: number;
    includedCredits: number;
    entitlements: Entitlement[];
    active: boolean;
}

export interface Subscription {
    id: string;
    organizationId: string;
    workspaceId: string;
    userId?: string;

    planId: string;
    status: SubscriptionStatus;
    interval: BillingInterval;

    currentPeriodStart: string;
    currentPeriodEnd: string;

    cancelAtPeriodEnd: boolean;
    createdAt: string;
    updatedAt: string;
}

export interface CreditBalance {
    id: string;
    organizationId: string;
    workspaceId: string;
    userId?: string;

    grantedCredits: number;
    consumedCredits: number;
    remainingCredits: number;

    updatedAt: string;
}

export interface CreditTransaction {
    id: string;
    organizationId: string;
    workspaceId: string;
    userId?: string;

    type: "GRANT" | "CONSUME" | "REFUND" | "ADJUSTMENT";
    credits: number;
    referenceId?: string;
    description: string;
    createdAt: string;
}

export interface Invoice {
    id: string;
    organizationId: string;
    workspaceId: string;
    subscriptionId?: string;

    amountUsd: number;
    currency: string;
    status: InvoiceStatus;

    issuedAt: string;
    dueAt?: string;
    paidAt?: string;
}

export interface Payment {
    id: string;
    invoiceId?: string;
    organizationId: string;
    workspaceId: string;

    provider: "RAZORPAY" | "STRIPE" | "OTHER";
    providerPaymentId?: string;

    amountUsd: number;
    currency: string;
    status: PaymentStatus;

    createdAt: string;
    updatedAt: string;
}

export interface Refund {
    id: string;
    paymentId: string;
    amountUsd: number;
    reason: string;
    status: "PENDING" | "COMPLETED" | "FAILED";
    createdAt: string;
}
