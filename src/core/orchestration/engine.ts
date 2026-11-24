import { join } from "node:path";

import { parseCommand } from "../command/parser";
import {
    buildContext,
    resolveContext,
} from "../context/resolver";
import { PersistentMemoryService } from "../memory/persistent-service";
import { ReasoningOrchestrator } from "../reasoning/orchestrator";
import { MissionOrchestrator } from "../mission/orchestrator";
import type { WorkerRuntimeCompositionDependencies } from "../mission/worker-runtime-composition";
import { MissionEngine } from "../mission/mission-engine";
import { TaskGraphEngine } from "../mission/task-graph";
import type { AsyncTenantPersistenceAdapter } from "../persistence/async-tenant-repository";

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
    DatabaseExecutionAdapter,
} from "../execution/database-execution-adapter";

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
    PipelineApprovalVerifier,
    TrustedPipelineExecutionContext,
} from "./types";

export class HappyOrchestrationEngine {

    private readonly reasoning: ReasoningOrchestrator;
    private readonly mission: MissionOrchestrator;
    private readonly execution: ExecutionEngine;

    private readonly persistence: PersistenceService;
    private readonly persistenceFile: string;

    constructor(
        persistenceFile?: string,
        private readonly approvalVerifier?: PipelineApprovalVerifier,
        private readonly tenantPersistence?: AsyncTenantPersistenceAdapter,
        workerRuntimeDependencies: WorkerRuntimeCompositionDependencies | null = null,
    ) {
        this.reasoning = new ReasoningOrchestrator();
        this.mission = new MissionOrchestrator(workerRuntimeDependencies);

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

        registry.register(
            new DatabaseExecutionAdapter(),
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

    /**
     * Exposes one bounded trusted-worker task iteration through the same
     * orchestration facade. It remains NOT_CONNECTED until server composition
     * supplies verified Vercel identity, live principal registry and DB broker.
     */
    runMissionTaskDispatch(
        input: Parameters<MissionOrchestrator["runMissionTaskDispatch"]>[0],
    ): ReturnType<MissionOrchestrator["runMissionTaskDispatch"]> {
        return this.mission.runMissionTaskDispatch(input);
    }

    runNextReadyMissionTaskDispatch(
        input: Omit<Parameters<MissionOrchestrator["runNextReadyMissionTaskDispatch"]>[0], "persistence">,
    ): ReturnType<MissionOrchestrator["runNextReadyMissionTaskDispatch"]> {
        if (!this.tenantPersistence) {
            return Promise.resolve({
                status: "NOT_CONNECTED",
                missing: "TENANT_PERSISTENCE",
            });
        }
        return this.mission.runNextReadyMissionTaskDispatch({
            ...input,
            persistence: this.tenantPersistence,
        });
    }

    async run(
        request: HappyPipelineRequest,
        trustedContext?: TrustedPipelineExecutionContext,
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

        const requesterUserId = request.userId;

        const trustedContextMatchesRequest =
            trustedContext !== undefined &&
            trustedContext.organizationId === request.organizationId &&
            trustedContext.workspaceId === request.workspaceId &&
            trustedContext.authenticatedActorUserId.trim().length > 0;

        // Durable pipeline mode binds persistence to the verified current actor.
        // A caller-supplied request.userId is never accepted as the database principal.
        const durableTenantScope =
            this.tenantPersistence &&
            trustedContextMatchesRequest &&
            requesterUserId !== undefined &&
            requesterUserId === trustedContext.authenticatedActorUserId
                ? {
                    organizationId: trustedContext.organizationId,
                    workspaceId: trustedContext.workspaceId,
                    userId: trustedContext.authenticatedActorUserId,
                }
                : undefined;

        if (this.tenantPersistence && !durableTenantScope) {
            addStage({
                stage: "PERSIST",
                status: "NOT_YET_CONNECTED",
                summary: "Durable mode requires a verified actor matching the request principal and exact tenant scope.",
            });
            return {
                requestId: request.id,
                status: "NOT_YET_CONNECTED",
                currentStage: "PERSIST",
                trace: {
                    requestId: request.id,
                    stages,
                    currentStage: "PERSIST",
                    status: "NOT_YET_CONNECTED",
                    startedAt,
                    completedAt: new Date().toISOString(),
                },
                evidenceIds: [],
                persisted: false,
            };
        }

        let verifiedApproval = false;

        if (
            approvalRequired &&
            trustedContextMatchesRequest &&
            requesterUserId !== undefined &&
            this.approvalVerifier !== undefined
        ) {
            try {
                verifiedApproval =
                    await this.approvalVerifier.verifyPersistedApproval({
                        requestId: request.id,
                        planId: plan.id,
                        organizationId: trustedContext.organizationId,
                        workspaceId: trustedContext.workspaceId,
                        requesterUserId,
                        authenticatedActorUserId: trustedContext.authenticatedActorUserId,
                    });
            } catch {
                // A verifier outage or unexpected adapter error must fail closed.
                verifiedApproval = false;
            }
        }

        // Caller-controlled request.approved is never proof of approval.
        // Fail closed unless a trusted server verifier validates the persisted
        // approval using the authenticated approver and tenant scope.
        if (
            approvalRequired &&
            !verifiedApproval
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
                    ? "Persisted approval verified by trusted server authorization."
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

        // The plan retains WAITING_APPROVAL as its audit history, but a
        // persisted approval has already been verified above. Seed the
        // executable mission as READY only on that trusted verification path.
        const missionPlan = verifiedApproval
            ? { ...plan, status: "READY" as const }
            : plan;
        const missionSnapshot = durableTenantScope && this.tenantPersistence
            ? await this.mission.createDurable(
                missionPlan,
                durableTenantScope,
                this.tenantPersistence,
            )
            : this.mission.create(missionPlan);

        if (!durableTenantScope) {
            await state.mission().create(
                missionSnapshot.mission.id,
                missionSnapshot.mission,
                request.userId,
            );
        }

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

        if (!durableTenantScope) {
            for (const task of missionSnapshot.graph.tasks) {
                await state.task().create(
                    task.id,
                    task,
                    request.userId,
                );
            }
        }

        if (missionSnapshot.graph.tasks.length === 0) {
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
        // EXECUTION + PER-TASK VERIFICATION
        // ==================================================

        const graphEngine = new TaskGraphEngine();
        const missionEngine = new MissionEngine();
        const evidenceRepository =
            new InMemoryEvidenceRepository();
        const evidenceService =
            new EvidenceService(evidenceRepository);
        const verificationEngine =
            new VerificationEngine(evidenceService);

        let currentMission = missionSnapshot.mission;
        let currentTasks = missionSnapshot.graph.tasks;

        const transitionTask = async (
            taskId: string,
            status: import("../mission/types").TaskStatus,
            verificationRequestId?: string,
            verificationEnvelope?: {
                request: import("../verification/types").VerificationRequest;
                evidence: import("../evidence/types").Evidence;
                result: import("../verification/types").VerificationResult;
            },
        ): Promise<{ mission: typeof currentMission; tasks: typeof currentTasks }> => {
            if (durableTenantScope && this.tenantPersistence) {
                const persisted = await this.mission.transitionTaskDurable({
                    scope: durableTenantScope,
                    persistence: this.tenantPersistence,
                    missionId: currentMission.id,
                    taskId,
                    status,
                    ...(verificationRequestId ? { verificationRequestId } : {}),
                    ...(verificationEnvelope ? { verificationEnvelope } : {}),
                });
                return { mission: persisted.mission, tasks: persisted.graph.tasks };
            }
            return missionEngine.updateTaskStatus(
                currentMission,
                currentTasks,
                taskId,
                status,
            );
        };

        let executionRequestId: string | undefined;
        let verificationRequestId: string | undefined;
        const allEvidenceIds: string[] = [];
        let sawNotConnected = false;
        let sawFailure = false;
        let sawBlocked = false;

        // Only dependency-ready tasks are eligible. A dependent task is never
        // released merely because its predecessor produced output; the
        // predecessor must pass its required verification first.
        while (true) {
            const readyTasks = graphEngine
                .getReadyTasks(
                    graphEngine.buildGraph(currentTasks),
                )
                .sort((left, right) =>
                    left.order - right.order ||
                    left.id.localeCompare(right.id),
                );

            if (readyTasks.length === 0) {
                break;
            }

            for (const task of readyTasks) {
                const running = await transitionTask(task.id, "RUNNING");
                currentMission = running.mission;
                currentTasks = running.tasks;

                const runningTask = currentTasks.find(
                    (item) => item.id === task.id,
                );
                if (!runningTask) {
                    throw new Error(
                        `Mission task disappeared while starting: ${task.id}`,
                    );
                }

                if (!durableTenantScope) {
                    await state.task().update(task.id, runningTask);
                    await state.mission().update(
                        currentMission.id,
                        currentMission,
                    );
                }

                const executionRequest = {
                    id: `exec-${request.id}-${task.id}`,
                    taskId: task.id,
                    missionId: currentMission.id,
                    capability: resolveExecutionCapability(
                        task.action,
                        task.targetReference,
                    ),
                    action: task.action,
                    input: {
                        command: request.command,
                        taskTitle: task.title,
                        taskDescription: task.description,
                        dependencyIds: task.dependencyIds,
                    },
                    targetReference: task.targetReference,
                    requiresApproval: task.requiresApproval,
                    // Approval is only propagated from the persisted,
                    // tenant-scoped verifier. Never infer approval from
                    // requiresApproval=false: sensitive actions are checked
                    // independently by ExecutionEngine.
                    approved: verifiedApproval,
                    risk: task.requiresApproval
                        ? "HIGH" as const
                        : "LOW" as const,
                    createdAt: new Date().toISOString(),
                };

                executionRequestId ??= executionRequest.id;
                let durableExecutionVersion: number | undefined;
                if (durableTenantScope && this.tenantPersistence) {
                    const persistedExecution = await this.tenantPersistence.transaction(
                        durableTenantScope,
                        (transaction) => transaction.create(
                            durableTenantScope,
                            "EXECUTION",
                            executionRequest.id,
                            executionRequest,
                        ),
                    );
                    durableExecutionVersion = persistedExecution.version;
                } else {
                    await state.execution().create(
                        executionRequest.id,
                        executionRequest,
                        request.userId,
                    );
                }

                const executionResult =
                    await this.execution.execute(executionRequest);

                const persistedExecutionResult = {
                    ...executionRequest,
                    ...executionResult,
                    targetReference: executionRequest.targetReference,
                };
                if (durableTenantScope && this.tenantPersistence && durableExecutionVersion !== undefined) {
                    await this.tenantPersistence.transaction(
                        durableTenantScope,
                        (transaction) => transaction.update(
                            durableTenantScope,
                            "EXECUTION",
                            executionRequest.id,
                            durableExecutionVersion,
                            persistedExecutionResult,
                        ),
                    );
                } else {
                    await state.execution().update(
                        executionRequest.id,
                        persistedExecutionResult,
                    );
                }

                const executionStageStatus:
                    HappyPipelineStageResult["status"] =
                    executionResult.status === "NOT_YET_CONNECTED"
                        ? "NOT_YET_CONNECTED"
                        : executionResult.status === "WAITING_APPROVAL"
                            ? "WAITING_APPROVAL"
                            : executionResult.status === "COMPLETED"
                                ? "COMPLETED"
                                : "FAILED";

                addStage({
                    stage: "EXECUTION",
                    status: executionStageStatus,
                    summary:
                        `Task "${task.title}" execution returned ${executionResult.status}.`,
                    referenceId: executionResult.id,
                    error: executionResult.error,
                });

                if (executionResult.status === "NOT_YET_CONNECTED") {
                    sawNotConnected = true;
                } else if (
                    executionResult.status === "FAILED"
                ) {
                    sawFailure = true;
                } else if (
                    executionResult.status !== "COMPLETED"
                ) {
                    sawBlocked = true;
                }

                const verifying = await transitionTask(task.id, "VERIFYING");
                currentMission = verifying.mission;
                currentTasks = verifying.tasks;
                const verifyingTask = currentTasks.find(
                    (item) => item.id === task.id,
                );
                if (!verifyingTask) {
                    throw new Error(
                        `Mission task disappeared before verification: ${task.id}`,
                    );
                }
                if (!durableTenantScope) {
                    await state.task().update(task.id, verifyingTask);
                    await state.mission().update(
                        currentMission.id,
                        currentMission,
                    );
                }

                const verificationRequest = {
                    id: `verification-${request.id}-${task.id}`,
                    missionId: currentMission.id,
                    taskId: task.id,
                    executionRequestId: executionResult.requestId,
                    description:
                        `Verify mission task: ${task.title}`,
                    criteria: [
                        {
                            id: "execution-status",
                            description:
                                "Execution must have a connected successful result.",
                            expected: "COMPLETED",
                            required: true,
                        },
                    ],
                    preferredMethods: [
                        "TEST" as const,
                        "COMMAND" as const,
                        "LOG" as const,
                    ],
                    requiresEvidence: true,
                    createdAt: new Date().toISOString(),
                };
                verificationRequestId = verificationRequest.id;

                const executionEvidence =
                    evidenceService.capture({
                        verificationRequestId:
                            verificationRequest.id,
                        executionRequestId:
                            executionResult.requestId,
                        missionId: currentMission.id,
                        taskId: task.id,
                        type: "COMMAND_OUTPUT" as const,
                        source: "EXECUTION" as const,
                        title: "Task execution result evidence",
                        content: JSON.stringify({
                            status: executionResult.status,
                            output: executionResult.output,
                            error: executionResult.error,
                        }),
                        metadata: {
                            capability: executionResult.capability,
                            executionResultId: executionResult.id,
                            taskId: task.id,
                        },
                        isPrimary: true,
                    });

                const verificationResult =
                    verificationEngine.verify(
                        verificationRequest,
                        [executionEvidence.id],
                    );

                if (!durableTenantScope || !this.tenantPersistence) {
                    await state.verification().create(
                        verificationRequest.id,
                        verificationRequest,
                        request.userId,
                    );
                    await state.evidence().create(
                        executionEvidence.id,
                        executionEvidence,
                        request.userId,
                    );
                    await state.verification().update(
                        verificationRequest.id,
                        verificationResult,
                    );
                }
                allEvidenceIds.push(
                    ...verificationResult.evidenceIds,
                );

                addStage({
                    stage: "VERIFICATION",
                    status:
                        verificationResult.status === "PASSED"
                            ? "COMPLETED"
                            : verificationResult.status === "PARTIAL"
                                ? "PARTIAL"
                                : "FAILED",
                    summary:
                        `Task "${task.title}": ${verificationResult.summary}`,
                    referenceId: verificationResult.id,
                    error: verificationResult.failureReason,
                });

                addStage({
                    stage: "EVIDENCE",
                    status:
                        verificationResult.evidenceIds.length > 0
                            ? "PROCESSING"
                            : "BLOCKED",
                    summary:
                        verificationResult.evidenceIds.length > 0
                            ? `Evidence captured for task "${task.title}".`
                            : `No evidence available for task "${task.title}".`,
                    referenceId: executionEvidence.id,
                });

                // Do not mark a task complete from an execution status alone
                // when semantic verification is required.
                const finalTaskStatus =
                    executionResult.status === "FAILED"
                        ? "FAILED" as const
                        : executionResult.status !== "COMPLETED"
                            ? "BLOCKED" as const
                            : !task.verificationRequired ||
                                verificationResult.status === "PASSED"
                                ? "COMPLETED" as const
                                : "BLOCKED" as const;

                if (finalTaskStatus === "BLOCKED") {
                    sawBlocked = true;
                }

                const finalized = await transitionTask(
                    task.id,
                    finalTaskStatus,
                    verificationRequest.id,
                    durableTenantScope && this.tenantPersistence
                        ? {
                            request: verificationRequest,
                            evidence: executionEvidence,
                            result: verificationResult,
                        }
                        : undefined,
                );
                currentMission = finalized.mission;
                currentTasks = finalized.tasks;

                const finalizedTask = currentTasks.find(
                    (item) => item.id === task.id,
                );
                if (!finalizedTask) {
                    throw new Error(
                        `Mission task disappeared after verification: ${task.id}`,
                    );
                }

                if (!durableTenantScope) {
                    await state.task().update(task.id, finalizedTask);
                    await state.mission().update(
                        currentMission.id,
                        currentMission,
                    );
                }
            }
        }

        const allTasksCompleted =
            currentTasks.length > 0 &&
            currentTasks.every(
                (task) => task.status === "COMPLETED",
            );

        const finalStatus:
            HappyPipelineResult["status"] =
            sawFailure
                ? "FAILED"
                : allTasksCompleted
                    ? "COMPLETED"
                    : sawNotConnected
                        ? "NOT_YET_CONNECTED"
                        : sawBlocked || currentTasks.some(
                            (task) => task.status === "BLOCKED",
                        )
                            ? "PARTIAL"
                            : "FAILED";

        const finalStage:
            HappyPipelineResult["currentStage"] =
            finalStatus === "COMPLETED"
                ? "COMPLETE"
                : finalStatus === "NOT_YET_CONNECTED"
                    ? "NOT_YET_CONNECTED"
                    : "BLOCKED";

        // A mission is only reported complete when every task has completed
        // and all required verification gates have passed.
        addStage({
            stage: "MISSION",
            status:
                currentMission.status === "COMPLETED"
                    ? "COMPLETED"
                    : currentMission.status === "BLOCKED"
                        ? "BLOCKED"
                        : currentMission.status === "FAILED"
                            ? "FAILED"
                            : "PARTIAL",
            summary:
                `Mission progress: ${currentMission.progressPercent}% (${currentMission.completedTaskIds.length}/${currentTasks.length} tasks verified complete).`,
            referenceId: currentMission.id,
        });

        // ==================================================
        // PERSIST
        // ==================================================

        const finalResult: HappyPipelineResult = {
            requestId: request.id,
            status: finalStatus,
            currentStage: finalStage,
            trace: {
                requestId: request.id,
                stages: [
                    ...stages,
                    {
                        stage: "PERSIST",
                        status: "COMPLETED",
                        summary:
                            "Mission, task transitions, executions, verification and evidence references persisted.",
                    },
                ],
                currentStage: finalStage,
                status: finalStatus,
                startedAt,
                completedAt: new Date().toISOString(),
            },
            missionId: currentMission.id,
            planId: plan.id,
            executionRequestId,
            verificationRequestId,
            evidenceIds: [...new Set(allEvidenceIds)],
            persisted: true,
        };

        await state.audit().create(
            `audit-final-${request.id}`,
            {
                event: "PIPELINE_FINALIZED",
                requestId: request.id,
                finalStatus,
                missionId: currentMission.id,
                planId: plan.id,
                executionRequestId,
                verificationRequestId,
                completedTaskIds: currentMission.completedTaskIds,
                blockedTaskIds: currentMission.blockedTaskIds,
                failedTaskIds: currentMission.failedTaskIds,
                trace: finalResult.trace,
                createdAt: new Date().toISOString(),
            },
            request.userId,
        );

        return finalResult;
    }
}
