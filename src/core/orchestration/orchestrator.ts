import {
    HappyOrchestrationEngine,
} from "./engine";

import type { AsyncTenantPersistenceAdapter } from "../persistence/async-tenant-repository";
import type { WorkerRuntimeCompositionDependencies } from "../mission/worker-runtime-composition";

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
        workerRuntimeDependencies?: WorkerRuntimeCompositionDependencies,
    ) {
        this.engine =
            new HappyOrchestrationEngine(
                persistenceFile,
                approvalVerifier,
                tenantPersistence,
                workerRuntimeDependencies,
            );
    }

    runMissionTaskDispatch(
        input: Parameters<HappyOrchestrationEngine["runMissionTaskDispatch"]>[0],
    ): ReturnType<HappyOrchestrationEngine["runMissionTaskDispatch"]> {
        return this.engine.runMissionTaskDispatch(input);
    }

    runNextReadyMissionTaskDispatch(
        input: Parameters<HappyOrchestrationEngine["runNextReadyMissionTaskDispatch"]>[0],
    ): ReturnType<HappyOrchestrationEngine["runNextReadyMissionTaskDispatch"]> {
        return this.engine.runNextReadyMissionTaskDispatch(input);
    }

    run(
        request: HappyPipelineRequest,
        trustedContext?: TrustedPipelineExecutionContext,
    ): Promise<HappyPipelineResult> {
        return this.engine.run(request, trustedContext);
    }
}
