import { WorkspaceService } from "./service";
import type {
    WorkspaceDashboard,
} from "./types";

export interface CommandCenterState {
    dashboard: WorkspaceDashboard;
    commandReady: boolean;
    voiceReady: boolean;
    approvalRequired: boolean;
}

export class CommandCenterService {
    constructor(
        private readonly workspace: WorkspaceService,
    ) {}

    snapshot(): CommandCenterState {
        const dashboard =
            this.workspace.dashboard();

        const approvalRequired =
            dashboard.missionQueue.some(
                (mission) =>
                    mission.status ===
                    "WAITING_APPROVAL",
            ) ||
            dashboard.currentMission?.status ===
                "WAITING_APPROVAL";

        return {
            dashboard,
            // The current workspace service is an in-memory view model only.
            // Keep command intake disabled until a verified tenant and durable
            // execution runtime are composed by the server.
            commandReady: false,
            voiceReady: false,
            approvalRequired,
        };
    }
}
