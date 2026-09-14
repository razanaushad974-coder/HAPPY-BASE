import {
    FounderCommandControlService,
} from "./command-control";
import { FounderOSService } from "./service";

export class FounderOSOrchestrator {
    readonly founder: FounderOSService;
    readonly commandControl:
        FounderCommandControlService;

    constructor() {
        this.founder =
            new FounderOSService();

        this.commandControl =
            new FounderCommandControlService(
                this.founder,
            );
    }
}
