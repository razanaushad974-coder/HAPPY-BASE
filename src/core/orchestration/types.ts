export type HappyPipelineStage =
    | "COMMAND"
    | "CONTEXT"
    | "MEMORY"
    | "REASON"
    | "PLAN"
    | "APPROVAL"
    | "MISSION"
    | "TASK_GRAPH"
    | "EXECUTION"
    | "VERIFICATION"
    | "EVIDENCE"
    | "PERSIST"
    | "COMPLETE"
    | "BLOCKED"
    | "NOT_YET_CONNECTED";

export type HappyPipelineStatus =
    | "RECEIVED"
    | "PROCESSING"
    | "WAITING_APPROVAL"
    | "RUNNING"
    | "VERIFYING"
    | "COMPLETED"
    | "PARTIAL"
    | "FAILED"
    | "BLOCKED"
    | "NOT_YET_CONNECTED";

export interface HappyPipelineRequest {
    id: string;
    command: string;
    organizationId: string;
    workspaceId: string;
    activeProjectId?: string;
    activeMissionId?: string;
    activeTaskId?: string;
    userId?: string;
    source:
        | "TEXT"
        | "VOICE"
        | "SYSTEM"
        | "API"
        | "AUTOMATION";
    approved?: boolean;
    createdAt: string;
}

export interface HappyPipelineStageResult {
    stage: HappyPipelineStage;
    status: HappyPipelineStatus;
    summary: string;
    referenceId?: string;
    error?: string;
}

export interface HappyPipelineTrace {
    requestId: string;
    stages: HappyPipelineStageResult[];
    currentStage: HappyPipelineStage;
    status: HappyPipelineStatus;
    startedAt: string;
    completedAt?: string;
}

export interface HappyPipelineResult {
    requestId: string;
    status: HappyPipelineStatus;
    currentStage: HappyPipelineStage;
    trace: HappyPipelineTrace;
    missionId?: string;
    planId?: string;
    executionRequestId?: string;
    verificationRequestId?: string;
    evidenceIds: string[];
    persisted: boolean;
}

