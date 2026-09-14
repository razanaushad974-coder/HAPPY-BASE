import {
    FounderOSOrchestrator,
} from "../../../core/founder-os/orchestrator";

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
        new FounderOSOrchestrator();

    os.founder.setIdentity({
        organizationId: "org-a",
        workspaceId: "founder-workspace",
        userId: "founder-1",
        displayName: "HAPPY Founder",
        accessLevel: "FOUNDER",
    });

    os.founder.enableCommandCenter(
        2,
        3,
        1,
    );

    os.founder.setMissionControl({
        total: 10,
        active: 3,
        waitingApproval: 2,
        completed: 4,
        failed: 0,
        blocked: 1,
    });

    os.founder.addAgent({
        agentId: "agent-code",
        name: "Code Agent",
        type: "BUILDER",
        status: "READY",
        activeTasks: 0,
    });

    os.founder.addAgent({
        agentId: "agent-research",
        name: "Research Agent",
        type: "RESEARCH",
        status: "NOT_YET_CONNECTED",
        activeTasks: 0,
    });

    os.founder.registerCapability({
        capability: "CODE",
        status: "NOT_YET_CONNECTED",
        enabled: true,
        requiresApproval: true,
    });

    os.founder.registerCapability({
        capability: "BROWSER",
        status: "NOT_YET_CONNECTED",
        enabled: true,
        requiresApproval: true,
    });

    os.founder.registerAIProvider({
        provider: "GEMINI",
        status: "NOT_YET_CONNECTED",
        primary: true,
        model: "NOT_YET_CONNECTED",
    });

    os.founder.registerAIProvider({
        provider: "GROQ",
        status: "NOT_YET_CONNECTED",
        primary: false,
    });

    os.founder.setSecurity({
        authentication: true,
        authorization: true,
        auditLogging: true,
        rateLimiting: true,
        approvalGates: true,
        tenantIsolation: true,
        credentialProtection: true,
    });

    os.founder.setApprovals({
        pending: 2,
        approvedToday: 5,
        rejectedToday: 1,
        expired: 0,
        criticalPending: 0,
    });

    os.founder.setAutomation({
        total: 8,
        active: 4,
        paused: 3,
        failed: 1,
    });

    os.founder.setAnalytics({
        missionsCompleted: 4,
        tasksCompleted: 22,
        executions: 31,
        verificationsPassed: 18,
        verificationsPartial: 3,
        verificationsFailed: 1,
        estimatedCostUsd: 4.25,
        actualCostUsd: 2.90,
    });

    os.founder.setHealth({
        overall: "DEGRADED",
        database: "FILE_BACKED",
        aiGateway: "NOT_YET_CONNECTED",
        execution: "CONTRACT_ONLY",
        verification: "FOUNDATION",
        persistence: "AVAILABLE",
        billing: "FOUNDATION",
    });

    const dashboard =
        os.founder.dashboard();

    assert(
        dashboard.identity.accessLevel ===
            "FOUNDER",
        "Founder identity failed.",
    );

    assert(
        dashboard.command.commandReady,
        "Founder command center failed.",
    );

    assert(
        dashboard.command.addressAs ===
            "boss",
        "Founder address contract failed.",
    );

    assert(
        dashboard.missions.total === 10,
        "Mission control failed.",
    );

    assert(
        dashboard.agents.length === 2,
        "Agent registry failed.",
    );

    assert(
        dashboard.capabilities.length === 2,
        "Capability control failed.",
    );

    assert(
        dashboard.aiProviders.length === 2,
        "AI provider registry failed.",
    );

    assert(
        dashboard.security.authentication &&
        dashboard.security.authorization &&
        dashboard.security.auditLogging &&
        dashboard.security.approvalGates,
        "Security control failed.",
    );

    assert(
        dashboard.approvals.pending === 2,
        "Approval summary failed.",
    );

    assert(
        dashboard.automation.active === 4,
        "Automation summary failed.",
    );

    assert(
        dashboard.analytics.executions === 31,
        "Analytics summary failed.",
    );

    assert(
        dashboard.sections.includes("BUILDER"),
        "Builder section missing.",
    );

    assert(
        dashboard.sections.includes("DIGITAL_HUMAN"),
        "Digital Human section missing.",
    );

    assert(
        dashboard.sections.includes("SECURITY"),
        "Security section missing.",
    );

    const control =
        os.commandControl.snapshot();

    assert(
        control.commandReady,
        "Command control readiness failed.",
    );

    assert(
        control.founderPrivileges,
        "Founder privilege detection failed.",
    );

    assert(
        control.approvalGateActive,
        "Approval gate detection failed.",
    );

    assert(
        control.emergencyControlReady,
        "Emergency control readiness failed.",
    );

    console.log(
        "STEP 22 Founder OS foundation test: PASS",
    );

    console.log({
        founderIdentity: true,
        founderCommandCenter: true,
        bossAddressContract: true,
        missionControl: true,
        agents: true,
        capabilities: true,
        aiProviders: true,
        securityControl: true,
        approvals: true,
        automation: true,
        analytics: true,
        builderSection: true,
        digitalHumanSection: true,
        founderPrivileges: true,
        approvalGate: true,
        emergencyControl: true,
    });
}

main().catch((error) => {
    console.error(error);
    process.exit(1);
});
