import { join } from "node:path";

import { parseCommand } from "../command/parser";
import {
    buildContext,
    resolveContext,
} from "../context/resolver";
import { PersistentMemoryService } from "../memory/persistent-service";
import { ReasoningOrchestrator } from "../reasoning/orchestrator";
import { MissionOrchestrator } from "../mission/orchestrator";

import {
    ExecutionAdapterRegistry,
} from "../execution/registry";

import {
    ExecutionEngine,
} from "../execution/engine";

import {
    resolveExecutionCapability,
} from "../execution/capability-resolver";

import {
    ContractExecutionAdapter,
} from "../execution/contract-adapter";

import {
    AIExecutionAdapter,
} from "../execution/ai-execution-adapter";

import {
    CodeExecutionAdapter,
} from "../execution/code-execution-adapter";

import {
    FileExecutionAdapter,
} from "../execution/file-execution-adapter";

import {
    ApiExecutionAdapter,
} from "../execution/api-execution-adapter";

import {
    BrowserExecutionAdapter,
} from "../execution/browser-execution-adapter";

import {
    VerificationEngine,
} from "../verification/engine";

import {
    InMemoryEvidenceRepository,
} from "../evidence/repository";

import {
    EvidenceService,
} from "../evidence/service";

import {
    JsonFileStateAdapter,
} from "../persistence/adapters/json-file-adapter";

import {
    PersistenceService,
} from "../persistence/service";

import {
    createHappyStateStore,
} from "../state/factory";

import type {
    HappyPipelineRequest,
    HappyPipelineResult,
    HappyPipelineStageResult,
} from "./types";

export class HappyOrchestrationEngine {

    private readonly reasoning: ReasoningOrchestrator;
    private readonly mission: MissionOrchestrator;
    private readonly execution: ExecutionEngine;

    private readonly persistence: PersistenceService;
    private readonly persistenceFile: string;

    constructor(
        persistenceFile?: string,
    ) {
        this.reasoning = new ReasoningOrchestrator();
        this.mission = new MissionOrchestrator();

        const registry =
            new ExecutionAdapterRegistry();

        const capabilities = [
            "CODE",
            "FILE",
            "API",
            "BROWSER",
            "SHELL",
            "DATABASE",
            "AI",
            "DEPLOYMENT",
            "PUBLISH",
            "AUTOMATION",
        ] as const;

        for (const capability of capabilities) {
            registry.register(
                new ContractExecutionAdapter(
                    capability,
                ),
            );
        }

        registry.register(
            new AIExecutionAdapter(),
        );

        registry.register(
            new CodeExecutionAdapter(),
        );

        registry.register(
            new FileExecutionAdapter(),
        );

        registry.register(
            new ApiExecutionAdapter(),
        );

        registry.register(
            new BrowserExecutionAdapter(),
        );

        this.execution =
            new ExecutionEngine(registry);

        this.persistenceFile =
            persistenceFile ??
            join(
                process.cwd(),
                ".happy-state",
                "orchestration-state.json",
            );

        this.persistence =
            new PersistenceService(
                new JsonFileStateAdapter(
                    this.persistenceFile,
                ),
            );
    }

    async run(
        request: HappyPipelineRequest,
    ): Promise<HappyPipelineResult> {
        const startedAt =
            new Date().toISOString();

        const stages: HappyPipelineStageResult[] = [];

        const addStage = (
            stage: HappyPipelineStageResult,
        ): void => {
            stages.push(stage);
        };

        const state =
            createHappyStateStore(
                this.persistence,
                request.organizationId,
                request.workspaceId,
                request.userId,
            );

        // ==================================================
        // COMMAND
        // ==================================================

        const commandResult =
            parseCommand(
                request.command,
                request.source,
            );

        addStage({
            stage: "COMMAND",
            status: "PROCESSING",
            summary:
                "Command normalized and classified.",
            referenceId:
                commandResult.command.id,
        });

        await state.repository("COMMAND").create(
            commandResult.command.id,
            commandResult.command,
            request.userId,
        );

        // ==================================================
        // MEMORY
        // ==================================================

        const persistentMemory =
            new PersistentMemoryService(
                request.organizationId,
                request.workspaceId,
                request.userId,
                this.persistenceFile,
                this.persistence,
            );

        const memoryKey =
            `pipeline:${request.id}`;

        const existingMemory =
            await persistentMemory.search({
                userId:
                    request.userId,
                workspaceId:
                    request.workspaceId,
                key:
                    memoryKey,
                limit:
                    1,
            });

        const commandMemory =
            existingMemory[0] ??
            await persistentMemory.remember({
                type:
                    "EPISODIC",
                scope:
                    "SESSION",
                userId:
                    request.userId,
                workspaceId:
                    request.workspaceId,
                key:
                    memoryKey,
                value:
                    request.command,
                confidence:
                    "HIGH",
                source:
                    "PIPELINE_COMMAND",
            });

        const memoryContext =
            await persistentMemory.search({
                userId:
                    request.userId,
                workspaceId:
                    request.workspaceId,
                limit:
                    20,
            });

        const memorySummary =
            memoryContext
                .map(
                    (memory) =>
                        `${memory.key}: ${memory.value}`,
                )
                .join("\n");

        const memoryCount =
            await persistentMemory.count();

        addStage({
            stage: "MEMORY",
            status: "COMPLETED",
            summary:
                "Persistent memory loaded and pipeline command retained.",
            referenceId:
                commandMemory.id,
        });

        // ==================================================
        // CONTEXT
        // ==================================================

        const contextResolution =
            resolveContext(
                {
                    userId:
                        request.userId,
                    workspaceId:
                        request.workspaceId,
                    activeProjectId:
                        request.activeProjectId,
                    activeMissionId:
                        request.activeMissionId,
                    activeTaskId:
                        request.activeTaskId,
                    memorySummary:
                        memorySummary,
                    recentCommand:
                        request.command,
                },
                request.command,
            );

        addStage({
            stage: "CONTEXT",
            status:
                contextResolution.requiresClarification
                    ? "BLOCKED"
                    : "COMPLETED",
            summary:
                contextResolution.requiresClarification
                    ? "Context contains unresolved references and requires clarification."
                    : "Context resolved with persistent memory.",
        });

        if (
            contextResolution.requiresClarification
        ) {
            return {
                requestId:
                    request.id,
                status:
                    "BLOCKED",
                currentStage:
                    "CONTEXT",
                trace: {
                    requestId:
                        request.id,
                    stages,
                    currentStage:
                        "CONTEXT",
                    status:
                        "BLOCKED",
                    startedAt,
                    completedAt:
                        new Date().toISOString(),
                },
                evidenceIds: [],
                persisted: false,
            };
        }
        // ==================================================
        // REASONING + PLAN
        // ==================================================


        const plan =
            await this.reasoning.createAIExecutionPlan({
                goal:
                    request.command,
                resolvedReferences:
                    contextResolution.resolvedReferences,
contextSummary:
                    JSON.stringify({
                        context:
                            contextResolution,
                        resolvedReferences:
                            contextResolution.resolvedReferences,
                        unresolvedReferences:
                            contextResolution.unresolvedReferences,
                        requiresClarification:
                            contextResolution.requiresClarification,
                        persistentMemory:
                            memorySummary,
                    }),
            });

        addStage({
            stage: "REASON",
            status: "PROCESSING",
            summary:
                "Reasoning engine evaluated the command.",
            referenceId:
                plan.reasoningRequestId,
        });

        addStage({
            stage: "PLAN",
            status:
                plan.steps.some(
                    (step) =>
                        step.requiresApproval,
                )
                    ? "WAITING_APPROVAL"
                    : "PROCESSING",
            summary:
                "Execution plan created.",
            referenceId:
                plan.id,
        });

        await state.mission().create(
            `plan-${plan.id}`,
            plan,
            request.userId,
        );

        // ==================================================
        // APPROVAL
        // ==================================================

        const approvalRequired =
            plan.steps.some(
                (step) =>
                    step.requiresApproval,
            );

        if (
            approvalRequired &&
            request.approved !== true
        ) {
            const approvalRecord = {
                requestId:
                    request.id,
                planId:
                    plan.id,
                status:
                    "WAITING_APPROVAL",
                createdAt:
                    new Date().toISOString(),
            };

            addStage({
                stage: "APPROVAL",
                status: "WAITING_APPROVAL",
                summary:
                    "Founder approval required before execution.",
            });

            await state.approval().create(
                `approval-${request.id}`,
                approvalRecord,
                request.userId,
            );

            await state.audit().create(
                `audit-${request.id}`,
                {
                    event:
                        "PIPELINE_WAITING_APPROVAL",
                    requestId:
                        request.id,
                    planId:
                        plan.id,
                    stage:
                        "APPROVAL",
                    createdAt:
                        new Date().toISOString(),
                },
                request.userId,
            );

            addStage({
                stage: "PERSIST",
                status: "COMPLETED",
                summary:
                    "Waiting-approval state persisted.",
            });

            return {
                requestId:
                    request.id,
                status:
                    "WAITING_APPROVAL",
                currentStage:
                    "APPROVAL",
                trace: {
                    requestId:
                        request.id,
                    stages,
                    currentStage:
                        "APPROVAL",
                    status:
                        "WAITING_APPROVAL",
                    startedAt,
                    completedAt:
                        new Date().toISOString(),
                },
                planId:
                    plan.id,
                evidenceIds: [],
                persisted: true,
            };
        }

        addStage({
            stage: "APPROVAL",
            status: "COMPLETED",
            summary:
                approvalRequired
                    ? "Approval supplied by caller."
                    : "Approval gate not required.",
        });

        if (approvalRequired) {
            await state.approval().create(
                `approval-${request.id}`,
                {
                    requestId:
                        request.id,
                    planId:
                        plan.id,
                    status:
                        "APPROVED",
                    approvedAt:
                        new Date().toISOString(),
                },
                request.userId,
            );
        }

        // ==================================================
        // MISSION
        // ==================================================

        const missionSnapshot =
            this.mission.create(plan);

        await state.mission().create(
            missionSnapshot.mission.id,
            missionSnapshot.mission,
            request.userId,
        );

        addStage({
            stage: "MISSION",
            status: "PROCESSING",
            summary:
                "Mission created from execution plan.",
            referenceId:
                missionSnapshot.mission.id,
        });

        // ==================================================
        // TASK GRAPH
        // ==================================================

        const firstTask =
            missionSnapshot.graph.tasks.find(
                (task) =>
                    task.targetReference !==
                    undefined,
            ) ??
            missionSnapshot.graph.tasks[0];

        for (
            const task of
            missionSnapshot.graph.tasks
        ) {
            await state.task().create(
                task.id,
                task,
                request.userId,
            );
        }

        if (!firstTask) {
            addStage({
                stage: "TASK_GRAPH",
                status: "BLOCKED",
                summary:
                    "Mission has no executable tasks.",
                referenceId:
                    missionSnapshot.mission.id,
            });

            await state.audit().create(
                `audit-${request.id}-blocked`,
                {
                    event:
                        "TASK_GRAPH_BLOCKED",
                    requestId:
                        request.id,
                    missionId:
                        missionSnapshot.mission.id,
                    createdAt:
                        new Date().toISOString(),
                },
                request.userId,
            );

            return {
                requestId:
                    request.id,
                status:
                    "BLOCKED",
                currentStage:
                    "TASK_GRAPH",
                trace: {
                    requestId:
                        request.id,
                    stages,
                    currentStage:
                        "TASK_GRAPH",
                    status:
                        "BLOCKED",
                    startedAt,
                    completedAt:
                        new Date().toISOString(),
                },
                planId:
                    plan.id,
                missionId:
                    missionSnapshot.mission.id,
                evidenceIds: [],
                persisted: true,
            };
        }

        addStage({
            stage: "TASK_GRAPH",
            status: "PROCESSING",
            summary:
                "Mission task graph created.",
            referenceId:
                missionSnapshot.mission.id,
        });

        // ==================================================
        // EXECUTION
        // ==================================================

        const executionRequest = {
            id:
                `exec-${request.id}`,
            taskId:
                firstTask.id,
            missionId:
                missionSnapshot.mission.id,
            capability:
                resolveExecutionCapability(
                    firstTask.action,
                    firstTask.targetReference,
                ),
            action:
                firstTask.action,
            input: {
                command:
                    request.command,
            },
            targetReference:
                firstTask.targetReference,
            requiresApproval:
                approvalRequired,
            approved:
                request.approved === true,
            risk:
                approvalRequired
                    ? "HIGH" as const
                    : "LOW" as const,
            createdAt:
                new Date().toISOString(),
        };

        await state.execution().create(
            executionRequest.id,
            executionRequest,
            request.userId,
        );

        const executionResult =
            await this.execution.execute(
                executionRequest,
            );

        await state.execution().update(
            executionRequest.id,
            {
                ...executionRequest,
                ...executionResult,
                targetReference:
                    executionRequest.targetReference,
            },
        );

        let executionStageStatus:
            HappyPipelineStageResult["status"];

        if (
            executionResult.status ===
            "NOT_YET_CONNECTED"
        ) {
            executionStageStatus =
                "NOT_YET_CONNECTED";
        } else if (
            executionResult.status ===
            "WAITING_APPROVAL"
        ) {
            executionStageStatus =
                "WAITING_APPROVAL";
        } else if (
            executionResult.status ===
            "COMPLETED"
        ) {
            executionStageStatus =
                "COMPLETED";
        } else {
            executionStageStatus =
                "FAILED";
        }

        addStage({
            stage: "EXECUTION",
            status:
                executionStageStatus,
            summary:
                executionResult.status ===
                "NOT_YET_CONNECTED"
                    ? "Execution adapter is not connected."
                    : "Execution boundary evaluated.",
            referenceId:
                executionResult.id,
        });

        // ==================================================
        // VERIFICATION + EVIDENCE
        // ==================================================

        const evidenceRepository =
            new InMemoryEvidenceRepository();

        const evidenceService =
            new EvidenceService(
                evidenceRepository,
            );

        const verificationEngine =
            new VerificationEngine(
                evidenceService,
            );

        const verificationRequest = {
            id:
                `verification-${request.id}`,
            missionId:
                missionSnapshot.mission.id,
            taskId:
                firstTask.id,
            executionRequestId:
                executionResult.requestId,
            description:
                "Verify the first mission task execution.",
            criteria: [
                {
                    id:
                        "execution-status",
                    description:
                        "Execution must have a connected successful result.",
                    expected:
                        "COMPLETED",
                    required:
                        true,
                },
            ],
            preferredMethods: [
                "TEST" as const,
                "COMMAND" as const,
                "LOG" as const,
            ],
            requiresEvidence:
                true,
            createdAt:
                new Date().toISOString(),
        };

        await state.verification().create(
            verificationRequest.id,
            verificationRequest,
            request.userId,
        );

        const executionEvidence =
            evidenceService.capture({
                verificationRequestId:
                    verificationRequest.id,
                executionRequestId:
                    executionResult.requestId,
                missionId:
                    missionSnapshot.mission.id,
                taskId:
                    firstTask.id,
                type:
                    "COMMAND_OUTPUT" as const,
                source:
                    "EXECUTION" as const,
                title:
                    "Execution result evidence",
                content:
                    JSON.stringify({
                        status:
                            executionResult.status,
                        output:
                            executionResult.output,
                        error:
                            executionResult.error,
                    }),
                metadata: {
                    capability:
                        executionResult.capability,
                    executionResultId:
                        executionResult.id,
                },
                isPrimary:
                    true,
            });

        await state.evidence().create(
            executionEvidence.id,
            executionEvidence,
            request.userId,
        );

        const verificationResult =
            verificationEngine.verify(
                verificationRequest,
                [executionEvidence.id],
            );

        await state.verification().update(
            verificationRequest.id,
            verificationResult,
        );

        addStage({
            stage: "VERIFICATION",
            status:
                verificationResult.status ===
                "PASSED"
                    ? "COMPLETED"
                    : verificationResult.status ===
                      "PARTIAL"
                        ? "PARTIAL"
                        : "FAILED",
            summary:
                verificationResult.summary,
            referenceId:
                verificationResult.id,
        });

        addStage({
            stage: "EVIDENCE",
            status:
                verificationResult.evidenceIds
                    .length > 0
                    ? "PROCESSING"
                    : "BLOCKED",
            summary:
                verificationResult.evidenceIds
                    .length > 0
                    ? "Evidence references available."
                    : "No evidence available.",
        });

        // ==================================================
        // PERSIST
        // ==================================================

        const finalStatus:
            HappyPipelineResult["status"] =
            executionResult.status ===
                "NOT_YET_CONNECTED"
                ? "NOT_YET_CONNECTED"
                : verificationResult.status ===
                    "PASSED"
                    ? "COMPLETED"
                    : verificationResult.status ===
                        "PARTIAL"
                        ? "PARTIAL"
                        : "FAILED";

        const finalStage:
            HappyPipelineResult["currentStage"] =
            finalStatus === "COMPLETED"
                ? "COMPLETE"
                : finalStatus ===
                    "NOT_YET_CONNECTED"
                    ? "NOT_YET_CONNECTED"
                    : "BLOCKED";

        const finalResult = {
            requestId:
                request.id,
            status:
                finalStatus,
            currentStage:
                finalStage,
            trace: {
                requestId:
                    request.id,
                stages: [
                    ...stages,
                    {
                        stage: "PERSIST" as const,
                        status: "COMPLETED" as const,
                        summary:
                            "Pipeline state persisted to file-backed state.",
                    },
                ],
                currentStage:
                    finalStage,
                status:
                    finalStatus,
                startedAt,
                completedAt:
                    new Date().toISOString(),
            },
            missionId:
                missionSnapshot.mission.id,
            planId:
                plan.id,
            executionRequestId:
                executionResult.requestId,
            verificationRequestId:
                verificationRequest.id,
            evidenceIds:
                verificationResult.evidenceIds,
            persisted:
                true,
        };

        await state.audit().create(
            `audit-final-${request.id}`,
            {
                event:
                    "PIPELINE_COMPLETED",
                requestId:
                    request.id,
                finalStatus,
                missionId:
                    missionSnapshot.mission.id,
                planId:
                    plan.id,
                executionRequestId:
                    executionResult.requestId,
                verificationRequestId:
                    verificationRequest.id,
                trace:
                    finalResult.trace,
                createdAt:
                    new Date().toISOString(),
            },
            request.userId,
        );

        return finalResult;
    }
}
