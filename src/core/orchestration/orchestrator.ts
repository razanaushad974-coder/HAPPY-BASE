import {
    HappyOrchestrationEngine,
} from "./engine";

import type {
    HappyPipelineRequest,
    HappyPipelineResult,
    PipelineApprovalVerifier,
} from "./types";

export class HappyOrchestrator {
    private readonly engine:
        HappyOrchestrationEngine;

    constructor(
        persistenceFile?: string,
        approvalVerifier?: PipelineApprovalVerifier,
    ) {
        this.engine =
            new HappyOrchestrationEngine(
                persistenceFile,
                approvalVerifier,
            );
    }

    run(
        request: HappyPipelineRequest,
    ): Promise<HappyPipelineResult> {
        return this.engine.run(request);
    }
}
