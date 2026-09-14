export type FounderOSSection =
    | "COMMAND"
    | "OVERVIEW"
    | "MISSIONS"
    | "TASKS"
    | "AGENTS"
    | "CAPABILITIES"
    | "AI"
    | "KNOWLEDGE"
    | "MEMORY"
    | "BUILDER"
    | "PROJECTS"
    | "FILES"
    | "AUTOMATION"
    | "BUSINESS"
    | "RESEARCH"
    | "DIGITAL_HUMAN"
    | "VOICE"
    | "SECURITY"
    | "APPROVALS"
    | "ANALYTICS"
    | "USAGE"
    | "SYSTEM"
    | "SETTINGS";

export type FounderSystemHealth =
    | "HEALTHY"
    | "DEGRADED"
    | "BLOCKED"
    | "CRITICAL"
    | "UNKNOWN";

export type FounderAccessLevel =
    | "FOUNDER"
    | "ADMIN"
    | "OPERATOR"
    | "VIEWER";

export interface FounderIdentity {
    organizationId: string;
    workspaceId: string;
    userId: string;
    displayName: string;
    accessLevel: FounderAccessLevel;
}

export interface FounderCommandState {
    commandReady: boolean;
    addressAs: "boss";
    pendingApprovals: number;
    activeMissions: number;
    blockedMissions: number;
}

export interface FounderMissionControl {
    total: number;
    active: number;
    waitingApproval: number;
    completed: number;
    failed: number;
    blocked: number;
}

export interface FounderAgentSummary {
    agentId: string;
    name: string;
    type: string;
    status:
        | "READY"
        | "RUNNING"
        | "PAUSED"
        | "FAILED"
        | "NOT_YET_CONNECTED";
    activeTasks: number;
}

export interface FounderCapabilityControl {
    capability: string;
    status:
        | "AVAILABLE"
        | "NOT_YET_CONNECTED"
        | "DISABLED"
        | "ERROR";
    enabled: boolean;
    requiresApproval: boolean;
}

export interface FounderAIProvider {
    provider: string;
    status:
        | "CONNECTED"
        | "NOT_YET_CONNECTED"
        | "DISABLED"
        | "ERROR";
    primary: boolean;
    model?: string;
}

export interface FounderSecurityState {
    authentication: boolean;
    authorization: boolean;
    auditLogging: boolean;
    rateLimiting: boolean;
    approvalGates: boolean;
    tenantIsolation: boolean;
    credentialProtection: boolean;
}

export interface FounderApprovalSummary {
    pending: number;
    approvedToday: number;
    rejectedToday: number;
    expired: number;
    criticalPending: number;
}

export interface FounderAutomationSummary {
    total: number;
    active: number;
    paused: number;
    failed: number;
}

export interface FounderAnalyticsSummary {
    missionsCompleted: number;
    tasksCompleted: number;
    executions: number;
    verificationsPassed: number;
    verificationsPartial: number;
    verificationsFailed: number;
    estimatedCostUsd: number;
    actualCostUsd: number;
}

export interface FounderSystemHealthState {
    overall: FounderSystemHealth;
    database: string;
    aiGateway: string;
    execution: string;
    verification: string;
    persistence: string;
    billing: string;
}

export interface FounderDashboard {
    identity: FounderIdentity;
    health: FounderSystemHealthState;

    command: FounderCommandState;
    missions: FounderMissionControl;

    agents: FounderAgentSummary[];
    capabilities: FounderCapabilityControl[];
    aiProviders: FounderAIProvider[];

    security: FounderSecurityState;
    approvals: FounderApprovalSummary;
    automation: FounderAutomationSummary;
    analytics: FounderAnalyticsSummary;

    sections: FounderOSSection[];
    generatedAt: string;
}
