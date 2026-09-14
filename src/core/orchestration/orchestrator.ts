import {
    HappyOrchestrationEngine,
} from "./engine";

import type {
    HappyPipelineRequest,
    HappyPipelineResult,
} from "./types";

export class HappyOrchestrator {
    private readonly engine:
        HappyOrchestrationEngine;

    constructor(
        persistenceFile?: string,
    ) {
        this.engine =
            new HappyOrchestrationEngine(
                persistenceFile,
            );
    }

    run(
        request: HappyPipelineRequest,
    ): Promise<HappyPipelineResult> {
        return this.engine.run(request);
    }
}
