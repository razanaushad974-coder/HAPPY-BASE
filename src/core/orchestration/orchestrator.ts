import {
    HappyOrchestrationEngine,
} from "./engine";

import type {
    HappyPipelineRequest,
    HappyPipelineResult,
    PipelineApprovalVerifier,
    TrustedPipelineExecutionContext,
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
        trustedContext?: TrustedPipelineExecutionContext,
    ): Promise<HappyPipelineResult> {
        return this.engine.run(request, trustedContext);
    }
}
