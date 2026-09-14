import type {
    FounderAIProvider,
    FounderAgentSummary,
    FounderApprovalSummary,
    FounderAutomationSummary,
    FounderCapabilityControl,
    FounderCommandState,
    FounderDashboard,
    FounderIdentity,
    FounderMissionControl,
    FounderOSSection,
    FounderSecurityState,
    FounderSystemHealthState,
    FounderAnalyticsSummary,
} from "./types";

export class FounderOSService {
    private identity?: FounderIdentity;

    private command: FounderCommandState = {
        commandReady: false,
        addressAs: "boss",
        pendingApprovals: 0,
        activeMissions: 0,
        blockedMissions: 0,
    };

    private missions: FounderMissionControl = {
        total: 0,
        active: 0,
        waitingApproval: 0,
        completed: 0,
        failed: 0,
        blocked: 0,
    };

    private readonly agents: FounderAgentSummary[] = [];
    private readonly capabilities: FounderCapabilityControl[] = [];
    private readonly aiProviders: FounderAIProvider[] = [];

    private security: FounderSecurityState = {
        authentication: false,
        authorization: false,
        auditLogging: false,
        rateLimiting: false,
        approvalGates: false,
        tenantIsolation: false,
        credentialProtection: false,
    };

    private approvals: FounderApprovalSummary = {
        pending: 0,
        approvedToday: 0,
        rejectedToday: 0,
        expired: 0,
        criticalPending: 0,
    };

    private automation: FounderAutomationSummary = {
        total: 0,
        active: 0,
        paused: 0,
        failed: 0,
    };

    private analytics: FounderAnalyticsSummary = {
        missionsCompleted: 0,
        tasksCompleted: 0,
        executions: 0,
        verificationsPassed: 0,
        verificationsPartial: 0,
        verificationsFailed: 0,
        estimatedCostUsd: 0,
        actualCostUsd: 0,
    };

    private health: FounderSystemHealthState = {
        overall: "UNKNOWN",
        database: "UNKNOWN",
        aiGateway: "UNKNOWN",
        execution: "UNKNOWN",
        verification: "UNKNOWN",
        persistence: "UNKNOWN",
        billing: "UNKNOWN",
    };

    setIdentity(identity: FounderIdentity): void {
        if (!identity.organizationId) {
            throw new Error("organizationId is required.");
        }

        if (!identity.workspaceId) {
            throw new Error("workspaceId is required.");
        }

        if (!identity.userId) {
            throw new Error("userId is required.");
        }

        this.identity = { ...identity };
    }

    enableCommandCenter(
        pendingApprovals = 0,
        activeMissions = 0,
        blockedMissions = 0,
    ): void {
        if (
            pendingApprovals < 0 ||
            activeMissions < 0 ||
            blockedMissions < 0
        ) {
            throw new Error(
                "Founder command counts cannot be negative.",
            );
        }

        this.command = {
            commandReady: true,
            addressAs: "boss",
            pendingApprovals,
            activeMissions,
            blockedMissions,
        };
    }

    setMissionControl(
        missions: FounderMissionControl,
    ): void {
        const values = [
            missions.total,
            missions.active,
            missions.waitingApproval,
            missions.completed,
            missions.failed,
            missions.blocked,
        ];

        if (values.some((value) => value < 0)) {
            throw new Error(
                "Mission control values cannot be negative.",
            );
        }

        this.missions = { ...missions };
    }

    addAgent(agent: FounderAgentSummary): void {
        this.agents.push({ ...agent });
    }

    registerCapability(
        capability: FounderCapabilityControl,
    ): void {
        this.capabilities.push({ ...capability });
    }

    registerAIProvider(
        provider: FounderAIProvider,
    ): void {
        this.aiProviders.push({ ...provider });
    }

    setSecurity(
        security: FounderSecurityState,
    ): void {
        this.security = { ...security };
    }

    setApprovals(
        approvals: FounderApprovalSummary,
    ): void {
        if (
            approvals.pending < 0 ||
            approvals.approvedToday < 0 ||
            approvals.rejectedToday < 0 ||
            approvals.expired < 0 ||
            approvals.criticalPending < 0
        ) {
            throw new Error(
                "Approval values cannot be negative.",
            );
        }

        this.approvals = { ...approvals };

        this.command = {
            ...this.command,
            pendingApprovals: approvals.pending,
        };
    }

    setAutomation(
        automation: FounderAutomationSummary,
    ): void {
        this.automation = { ...automation };
    }

    setAnalytics(
        analytics: FounderAnalyticsSummary,
    ): void {
        if (
            analytics.missionsCompleted < 0 ||
            analytics.tasksCompleted < 0 ||
            analytics.executions < 0 ||
            analytics.verificationsPassed < 0 ||
            analytics.verificationsPartial < 0 ||
            analytics.verificationsFailed < 0 ||
            analytics.estimatedCostUsd < 0 ||
            analytics.actualCostUsd < 0
        ) {
            throw new Error(
                "Analytics values cannot be negative.",
            );
        }

        this.analytics = { ...analytics };
    }

    setHealth(
        health: FounderSystemHealthState,
    ): void {
        this.health = { ...health };
    }

    dashboard(): FounderDashboard {
        if (!this.identity) {
            throw new Error(
                "Founder identity is not configured.",
            );
        }

        const sections: FounderOSSection[] = [
            "COMMAND",
            "OVERVIEW",
            "MISSIONS",
            "TASKS",
            "AGENTS",
            "CAPABILITIES",
            "AI",
            "KNOWLEDGE",
            "MEMORY",
            "BUILDER",
            "PROJECTS",
            "FILES",
            "AUTOMATION",
            "BUSINESS",
            "RESEARCH",
            "DIGITAL_HUMAN",
            "VOICE",
            "SECURITY",
            "APPROVALS",
            "ANALYTICS",
            "USAGE",
            "SYSTEM",
            "SETTINGS",
        ];

        return {
            identity: { ...this.identity },
            health: { ...this.health },
            command: { ...this.command },
            missions: { ...this.missions },
            agents: this.agents.map(
                (agent) => ({ ...agent }),
            ),
            capabilities: this.capabilities.map(
                (capability) => ({ ...capability }),
            ),
            aiProviders: this.aiProviders.map(
                (provider) => ({ ...provider }),
            ),
            security: { ...this.security },
            approvals: { ...this.approvals },
            automation: { ...this.automation },
            analytics: { ...this.analytics },
            sections,
            generatedAt:
                new Date().toISOString(),
        };
    }
}
