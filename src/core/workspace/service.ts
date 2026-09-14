import type {
    WorkspaceCapabilitySummary,
    WorkspaceDashboard,
    WorkspaceFileSummary,
    WorkspaceIdentity,
    WorkspaceMemorySummary,
    WorkspaceMissionSummary,
    WorkspaceNotification,
    WorkspaceProjectSummary,
    WorkspaceTaskSummary,
    WorkspaceTimelineEvent,
    WorkspaceUsageSummary,
    WorkspaceVerificationSummary,
    WorkspaceWorkflowSummary,
} from "./types";

export class WorkspaceService {
    private identity?: WorkspaceIdentity;
    private currentMission?: WorkspaceMissionSummary;

    private readonly missionQueue: WorkspaceMissionSummary[] = [];
    private readonly readyTasks: WorkspaceTaskSummary[] = [];
    private readonly timeline: WorkspaceTimelineEvent[] = [];
    private readonly projects: WorkspaceProjectSummary[] = [];
    private readonly workflows: WorkspaceWorkflowSummary[] = [];
    private readonly capabilities: WorkspaceCapabilitySummary[] = [];
    private readonly files: WorkspaceFileSummary[] = [];
    private readonly verifications: WorkspaceVerificationSummary[] = [];
    private readonly notifications: WorkspaceNotification[] = [];

    private memory: WorkspaceMemorySummary = {
        total: 0,
        user: 0,
        project: 0,
        mission: 0,
        task: 0,
        session: 0,
    };

    private usage: WorkspaceUsageSummary = {
        estimatedCostUsd: 0,
        actualCostUsd: 0,
        totalTokens: 0,
    };

    setIdentity(identity: WorkspaceIdentity): void {
        if (!identity.organizationId) {
            throw new Error(
                "organizationId is required.",
            );
        }

        if (!identity.workspaceId) {
            throw new Error(
                "workspaceId is required.",
            );
        }

        this.identity = { ...identity };
    }

    setCurrentMission(
        mission: WorkspaceMissionSummary,
    ): void {
        if (mission.progressPercent < 0 ||
            mission.progressPercent > 100) {
            throw new Error(
                "Mission progress must be between 0 and 100.",
            );
        }

        this.currentMission = {
            ...mission,
        };
    }

    addMissionToQueue(
        mission: WorkspaceMissionSummary,
    ): void {
        this.missionQueue.push({
            ...mission,
        });
    }

    addReadyTask(
        task: WorkspaceTaskSummary,
    ): void {
        this.readyTasks.push({
            ...task,
        });
    }

    addTimelineEvent(
        event: WorkspaceTimelineEvent,
    ): void {
        this.timeline.push({
            ...event,
        });
    }

    setMemorySummary(
        memory: WorkspaceMemorySummary,
    ): void {
        if (memory.total < 0) {
            throw new Error(
                "Memory total cannot be negative.",
            );
        }

        this.memory = {
            ...memory,
        };
    }

    addProject(
        project: WorkspaceProjectSummary,
    ): void {
        this.projects.push({
            ...project,
        });
    }

    addWorkflow(
        workflow: WorkspaceWorkflowSummary,
    ): void {
        this.workflows.push({
            ...workflow,
        });
    }

    registerCapability(
        capability: WorkspaceCapabilitySummary,
    ): void {
        this.capabilities.push({
            ...capability,
        });
    }

    addFile(
        file: WorkspaceFileSummary,
    ): void {
        this.files.push({
            ...file,
        });
    }

    addVerification(
        verification: WorkspaceVerificationSummary,
    ): void {
        this.verifications.push({
            ...verification,
        });
    }

    addNotification(
        notification: WorkspaceNotification,
    ): void {
        this.notifications.push({
            ...notification,
        });
    }

    setUsage(
        usage: WorkspaceUsageSummary,
    ): void {
        if (usage.estimatedCostUsd < 0 ||
            usage.actualCostUsd < 0 ||
            usage.totalTokens < 0) {
            throw new Error(
                "Usage values cannot be negative.",
            );
        }

        this.usage = {
            ...usage,
        };
    }

    dashboard(): WorkspaceDashboard {
        if (!this.identity) {
            throw new Error(
                "Workspace identity is not configured.",
            );
        }

        const blockedMission =
            this.currentMission?.status === "BLOCKED";

        const failedMission =
            this.currentMission?.status === "FAILED";

        const health =
            blockedMission
                ? "BLOCKED"
                : failedMission
                    ? "DEGRADED"
                    : "HEALTHY";

        return {
            identity: {
                ...this.identity,
            },
            health,
            currentMission: this.currentMission
                ? { ...this.currentMission }
                : undefined,
            missionQueue:
                this.missionQueue.map(
                    (mission) => ({ ...mission }),
                ),
            readyTasks:
                this.readyTasks.map(
                    (task) => ({ ...task }),
                ),
            timeline:
                this.timeline.map(
                    (event) => ({ ...event }),
                ),
            memory: {
                ...this.memory,
            },
            projects:
                this.projects.map(
                    (project) => ({ ...project }),
                ),
            workflows:
                this.workflows.map(
                    (workflow) => ({ ...workflow }),
                ),
            capabilities:
                this.capabilities.map(
                    (capability) => ({ ...capability }),
                ),
            files:
                this.files.map(
                    (file) => ({ ...file }),
                ),
            verifications:
                this.verifications.map(
                    (verification) => ({ ...verification }),
                ),
            notifications:
                this.notifications.map(
                    (notification) => ({ ...notification }),
                ),
            usage: {
                ...this.usage,
            },
            generatedAt:
                new Date().toISOString(),
        };
    }
}
