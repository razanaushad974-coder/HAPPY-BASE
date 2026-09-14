import {
    UserOSOrchestrator,
} from "../../../core/workspace/orchestrator";

function assert(
    condition: boolean,
    message: string,
): void {
    if (!condition) {
        throw new Error(message);
    }
}

async function main(): Promise<void> {
    const os =
        new UserOSOrchestrator();

    os.workspace.setIdentity({
        organizationId: "org-a",
        workspaceId: "workspace-a",
        userId: "user-a",
        name: "HAPPY Workspace",
        language: "en-IN",
        timezone: "Asia/Kolkata",
    });

    os.workspace.setCurrentMission({
        missionId: "mission-1",
        goal: "Build HAPPY",
        status: "RUNNING",
        progressPercent: 40,
        taskCount: 5,
        completedTaskCount: 2,
        failedTaskCount: 0,
        blockedTaskCount: 0,
    });

    os.workspace.addMissionToQueue({
        missionId: "mission-2",
        goal: "Research capabilities",
        status: "WAITING_APPROVAL",
        progressPercent: 0,
        taskCount: 4,
        completedTaskCount: 0,
        failedTaskCount: 0,
        blockedTaskCount: 0,
    });

    os.workspace.addReadyTask({
        taskId: "task-3",
        missionId: "mission-1",
        title: "Verify implementation",
        status: "READY",
        order: 3,
        dependencyCount: 2,
    });

    os.workspace.addTimelineEvent({
        id: "event-1",
        type: "MISSION",
        title: "Mission started",
        timestamp:
            "2026-09-14T10:00:00.000Z",
        status: "RUNNING",
        referenceId: "mission-1",
    });

    os.workspace.setMemorySummary({
        total: 12,
        user: 3,
        project: 3,
        mission: 2,
        task: 2,
        session: 2,
    });

    os.workspace.addProject({
        projectId: "project-1",
        name: "HAPPY AI",
        status: "ACTIVE",
        updatedAt:
            "2026-09-14T10:00:00.000Z",
    });

    os.workspace.addWorkflow({
        workflowId: "workflow-1",
        name: "Build Verification",
        status: "READY",
        enabled: true,
    });

    os.workspace.registerCapability({
        capability: "CODE",
        status: "NOT_YET_CONNECTED",
    });

    os.workspace.registerCapability({
        capability: "AI",
        status: "NOT_YET_CONNECTED",
    });

    os.workspace.addFile({
        fileId: "file-1",
        name: "requirements.md",
        kind: "MD",
        status: "READY",
        sizeBytes: 2048,
    });

    os.workspace.addVerification({
        verificationId: "verification-1",
        missionId: "mission-1",
        taskId: "task-3",
        status: "PARTIAL",
        confidence: "LOW",
        evidenceCount: 1,
    });

    os.workspace.addNotification({
        id: "notification-1",
        type: "APPROVAL",
        title: "Approval required",
        message:
            "Mission 2 requires approval.",
        read: false,
        createdAt:
            "2026-09-14T10:05:00.000Z",
    });

    os.workspace.setUsage({
        estimatedCostUsd: 2.5,
        actualCostUsd: 0,
        totalTokens: 3_000_000,
        remainingCredits: 97,
    });

    const dashboard =
        os.workspace.dashboard();

    assert(
        dashboard.identity.workspaceId ===
            "workspace-a",
        "Workspace identity failed.",
    );

    assert(
        dashboard.currentMission?.missionId ===
            "mission-1",
        "Current mission failed.",
    );

    assert(
        dashboard.missionQueue.length === 1,
        "Mission queue failed.",
    );

    assert(
        dashboard.readyTasks.length === 1,
        "Ready task summary failed.",
    );

    assert(
        dashboard.timeline.length === 1,
        "Timeline failed.",
    );

    assert(
        dashboard.memory.total === 12,
        "Memory summary failed.",
    );

    assert(
        dashboard.projects.length === 1,
        "Project summary failed.",
    );

    assert(
        dashboard.workflows.length === 1,
        "Workflow summary failed.",
    );

    assert(
        dashboard.capabilities.length === 2,
        "Capability summary failed.",
    );

    assert(
        dashboard.files.length === 1,
        "File summary failed.",
    );

    assert(
        dashboard.verifications.length === 1,
        "Verification summary failed.",
    );

    assert(
        dashboard.notifications.length === 1,
        "Notification summary failed.",
    );

    assert(
        dashboard.usage.totalTokens === 3_000_000,
        "Usage summary failed.",
    );

    const commandCenter =
        os.commandCenter.snapshot();

    assert(
        commandCenter.commandReady,
        "Command center readiness failed.",
    );

    assert(
        !commandCenter.voiceReady,
        "Voice should remain explicitly unavailable.",
    );

    assert(
        commandCenter.approvalRequired,
        "Approval detection failed.",
    );

    assert(
        dashboard.health === "HEALTHY",
        "Workspace health calculation failed.",
    );

    os.workspace.setCurrentMission({
        missionId: "mission-1",
        goal: "Build HAPPY",
        status: "BLOCKED",
        progressPercent: 40,
        taskCount: 5,
        completedTaskCount: 2,
        failedTaskCount: 0,
        blockedTaskCount: 1,
    });

    assert(
        os.workspace.dashboard().health ===
            "BLOCKED",
        "Blocked workspace health failed.",
    );

    console.log(
        "STEP 21 User OS foundation test: PASS",
    );

    console.log({
        workspaceIdentity: true,
        currentMission: true,
        missionQueue: true,
        readyTasks: true,
        timeline: true,
        memory: true,
        projects: true,
        workflows: true,
        capabilities: true,
        files: true,
        verification: true,
        notifications: true,
        usage: true,
        commandCenter: true,
        approvalDetection: true,
        blockedHealthDetection: true,
        voiceExplicitlyNotConnected:
            !commandCenter.voiceReady,
    });
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
