export type WorkspaceSection =
    | "COMMAND_CENTER"
    | "MISSIONS"
    | "TASKS"
    | "TIMELINE"
    | "MEMORY"
    | "PROJECTS"
    | "WORKFLOWS"
    | "CAPABILITIES"
    | "FILES"
    | "VERIFICATION"
    | "NOTIFICATIONS"
    | "USAGE"
    | "SETTINGS";

export type WorkspaceHealth =
    | "HEALTHY"
    | "DEGRADED"
    | "BLOCKED"
    | "UNKNOWN";

export interface WorkspaceIdentity {
    organizationId: string;
    workspaceId: string;
    userId?: string;
    name: string;
    language: string;
    timezone: string;
}

export interface WorkspaceMissionSummary {
    missionId: string;
    goal: string;
    status: string;
    progressPercent: number;
    taskCount: number;
    completedTaskCount: number;
    failedTaskCount: number;
    blockedTaskCount: number;
}

export interface WorkspaceTaskSummary {
    taskId: string;
    missionId: string;
    title: string;
    status: string;
    order: number;
    dependencyCount: number;
}

export interface WorkspaceTimelineEvent {
    id: string;
    type:
        | "COMMAND"
        | "MISSION"
        | "TASK"
        | "EXECUTION"
        | "VERIFICATION"
        | "MEMORY"
        | "SYSTEM";
    title: string;
    description?: string;
    timestamp: string;
    status?: string;
    referenceId?: string;
}

export interface WorkspaceMemorySummary {
    total: number;
    user: number;
    project: number;
    mission: number;
    task: number;
    session: number;
}

export interface WorkspaceProjectSummary {
    projectId: string;
    name: string;
    status: string;
    updatedAt: string;
}

export interface WorkspaceWorkflowSummary {
    workflowId: string;
    name: string;
    status: string;
    enabled: boolean;
}

export interface WorkspaceCapabilitySummary {
    capability: string;
    status:
        | "AVAILABLE"
        | "NOT_YET_CONNECTED"
        | "DISABLED"
        | "ERROR";
}

export interface WorkspaceFileSummary {
    fileId: string;
    name: string;
    kind: string;
    status: string;
    sizeBytes?: number;
}

export interface WorkspaceVerificationSummary {
    verificationId: string;
    missionId: string;
    taskId?: string;
    status: string;
    confidence?: string;
    evidenceCount: number;
}

export interface WorkspaceNotification {
    id: string;
    type:
        | "INFO"
        | "SUCCESS"
        | "WARNING"
        | "ERROR"
        | "APPROVAL"
        | "SECURITY";
    title: string;
    message: string;
    read: boolean;
    createdAt: string;
}

export interface WorkspaceUsageSummary {
    estimatedCostUsd: number;
    actualCostUsd: number;
    totalTokens: number;
    remainingCredits?: number;
}

export interface WorkspaceDashboard {
    identity: WorkspaceIdentity;
    health: WorkspaceHealth;

    currentMission?: WorkspaceMissionSummary;
    missionQueue: WorkspaceMissionSummary[];
    readyTasks: WorkspaceTaskSummary[];

    timeline: WorkspaceTimelineEvent[];

    memory: WorkspaceMemorySummary;
    projects: WorkspaceProjectSummary[];
    workflows: WorkspaceWorkflowSummary[];
    capabilities: WorkspaceCapabilitySummary[];
    files: WorkspaceFileSummary[];
    verifications: WorkspaceVerificationSummary[];
    notifications: WorkspaceNotification[];
    usage: WorkspaceUsageSummary;

    generatedAt: string;
}
