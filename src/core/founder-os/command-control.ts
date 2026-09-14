import { FounderOSService } from "./service";
import type { FounderDashboard } from "./types";

export interface FounderCommandControl {
    dashboard: FounderDashboard;
    commandReady: boolean;
    founderPrivileges: boolean;
    approvalGateActive: boolean;
    emergencyControlReady: boolean;
}

export class FounderCommandControlService {
    constructor(
        private readonly founder: FounderOSService,
    ) {}

    snapshot(): FounderCommandControl {
        const dashboard =
            this.founder.dashboard();

        const founderPrivileges =
            dashboard.identity.accessLevel ===
            "FOUNDER";

        const approvalGateActive =
            dashboard.security.approvalGates &&
            dashboard.approvals.pending > 0;

        const emergencyControlReady =
            dashboard.security.authentication &&
            dashboard.security.authorization &&
            dashboard.security.auditLogging;

        return {
            dashboard,
            commandReady:
                dashboard.command.commandReady,
            founderPrivileges,
            approvalGateActive,
            emergencyControlReady,
        };
    }
}
