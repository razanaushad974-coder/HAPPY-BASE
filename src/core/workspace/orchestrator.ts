import {
    CommandCenterService,
} from "./command-center";
import { WorkspaceService } from "./service";

export class UserOSOrchestrator {
    readonly workspace: WorkspaceService;
    readonly commandCenter: CommandCenterService;

    constructor() {
        this.workspace =
            new WorkspaceService();

        this.commandCenter =
            new CommandCenterService(
                this.workspace,
            );
    }
}
