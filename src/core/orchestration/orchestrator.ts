import {
    HappyOrchestrationEngine,
} from "./engine";

import type { AsyncTenantPersistenceAdapter } from "../persistence/async-tenant-repository";

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
        tenantPersistence?: AsyncTenantPersistenceAdapter,
    ) {
        this.engine =
            new HappyOrchestrationEngine(
                persistenceFile,
                approvalVerifier,
                tenantPersistence,
            );
    }

    run(
        request: HappyPipelineRequest,
        trustedContext?: TrustedPipelineExecutionContext,
    ): Promise<HappyPipelineResult> {
        return this.engine.run(request, trustedContext);
    }
}
