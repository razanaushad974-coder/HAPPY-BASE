import {
    existsSync,
    rmSync,
} from "node:fs";

import {
    join,
} from "node:path";

import {
    HappyOrchestrator,
} from "../../../core/orchestration/orchestrator";

import {
    JsonFileStateAdapter,
} from "../../../core/persistence/adapters/json-file-adapter";

import {
    PersistenceService,
} from "../../../core/persistence/service";

import {
    createHappyStateStore,
} from "../../../core/state/factory";

function assert(
    condition: boolean,
    message: string,
): void {
    if (!condition) {
        throw new Error(message);
    }
}

async function main(): Promise<void> {
    const testDirectory =
        join(
            process.cwd(),
            ".happy-step23-persistence-test",
        );

    const stateFile =
        join(
            testDirectory,
            "orchestration-state.json",
        );

    if (existsSync(testDirectory)) {
        rmSync(
            testDirectory,
            {
                recursive: true,
                force: true,
            },
        );
    }

    // ==============================================
    // FIRST ORCHESTRATOR INSTANCE
    // ==============================================

    const happy =
        new HappyOrchestrator(
            stateFile,
        );

    const lowRisk =
        await happy.run({
            id:
                "pipeline-low-risk",
            command:
                "research the current HAPPY architecture",
            organizationId:
                "org-a",
            workspaceId:
                "workspace-a",
            activeProjectId:
                "project-happy",
            activeMissionId:
                "mission-001",
            activeTaskId:
                "task-001",
            userId:
                "user-a",
            source:
                "TEXT",
            approved:
                false,
            createdAt:
                new Date().toISOString(),
        });

    assert(
        lowRisk.trace.stages.some(
            (stage) =>
                stage.stage === "COMMAND",
        ),
        "COMMAND stage missing.",
    );

    assert(
        lowRisk.trace.stages.some(
            (stage) =>
                stage.stage === "CONTEXT",
        ),
        "CONTEXT stage missing.",
    );

    assert(
        lowRisk.trace.stages.some(
            (stage) =>
                stage.stage === "MEMORY",
        ),
        "MEMORY stage missing.",
    );

    assert(
        lowRisk.trace.stages.some(
            (stage) =>
                stage.stage === "REASON",
        ),
        "REASON stage missing.",
    );

    assert(
        lowRisk.trace.stages.some(
            (stage) =>
                stage.stage === "PLAN",
        ),
        "PLAN stage missing.",
    );

    // ==============================================
    // HIGH-RISK APPROVAL
    // ==============================================

    const approvalCase =
        await happy.run({
            id:
                "pipeline-approval",
            command:
                "deploy the HAPPY application to production",
            organizationId:
                "org-a",
            workspaceId:
                "workspace-a",
            activeProjectId:
                "project-happy",
            activeMissionId:
                "mission-001",
            activeTaskId:
                "task-001",
            userId:
                "user-a",
            source:
                "TEXT",
            approved:
                false,
            createdAt:
                new Date().toISOString(),
        });

    assert(
        approvalCase.status ===
            "WAITING_APPROVAL",
        "Approval gate failed.",
    );

    assert(
        approvalCase.persisted,
        "Waiting approval result was not persisted.",
    );

    assert(
        !approvalCase.trace.stages.some(
            (stage) =>
                stage.stage ===
                "EXECUTION",
        ),
        "Execution happened before approval.",
    );

    // ==============================================
    // APPROVED EXECUTION
    // ==============================================

    const approvedCase =
        await happy.run({
            id:
                "pipeline-approved",
            command:
                "deploy this project to production",
            organizationId:
                "org-a",
            workspaceId:
                "workspace-a",
            activeProjectId:
                "project-happy",
            activeMissionId:
                "mission-001",
            activeTaskId:
                "task-001",
            userId:
                "user-a",
            source:
                "TEXT",
            approved:
                true,
            createdAt:
                new Date().toISOString(),
        });

    assert(
        approvedCase.trace.stages.some(
            (stage) =>
                stage.stage ===
                "MISSION",
        ),
        "MISSION stage missing.",
    );

    assert(
        approvedCase.trace.stages.some(
            (stage) =>
                stage.stage ===
                "TASK_GRAPH",
        ),
        "TASK_GRAPH stage missing.",
    );

    assert(
        approvedCase.trace.stages.some(
            (stage) =>
                stage.stage ===
                "EXECUTION",
        ),
        "EXECUTION stage missing.",
    );

    assert(
        approvedCase.trace.stages.some(
            (stage) =>
                stage.stage ===
                "VERIFICATION",
        ),
        "VERIFICATION stage missing.",
    );

    assert(
        approvedCase.trace.stages.some(
            (stage) =>
                stage.stage ===
                "PERSIST" &&
                stage.status ===
                "COMPLETED",
        ),
        "PERSIST completion missing.",
    );

    assert(
        approvedCase.persisted,
        "Pipeline persistence flag is false.",
    );

    assert(
        approvedCase.status !==
            "COMPLETED",
        "Fake real-world completion detected.",
    );

    assert(
        approvedCase.status ===
            "NOT_YET_CONNECTED" ||
        approvedCase.status ===
            "PARTIAL" ||
        approvedCase.status ===
            "FAILED",
        "Unexpected approved pipeline state.",
    );

    // ==============================================
    // FILE EXISTS
    // ==============================================

    assert(
        existsSync(stateFile),
        "Orchestration persistence file was not created.",
    );

    // ==============================================
    // RESTART SIMULATION
    // ==============================================

    const restartedPersistence =
        new PersistenceService(
            new JsonFileStateAdapter(
                stateFile,
            ),
        );

    const restartedStore =
        createHappyStateStore(
            restartedPersistence,
            "org-a",
            "workspace-a",
            "user-a",
        );

    const restoredCommand =
        await restartedStore
            .repository("COMMAND")
            .list();

    const restoredMission =
        approvedCase.missionId
            ? await restartedStore
                .mission()
                .get(
                    approvedCase.missionId,
                )
            : undefined;

    const restoredExecution =
        approvedCase.executionRequestId
            ? await restartedStore
                .execution()
                .get(
                    approvedCase.executionRequestId,
                )
            : undefined;

    type PersistedExecutionTarget = {
        targetReference?: {
            entityId?: string;
            entityType?: string;
        };
    };

    const restoredExecutionTarget =
        restoredExecution as unknown as
            PersistedExecutionTarget | undefined;

    const executionTargetPreserved =
        restoredExecutionTarget?.targetReference?.entityId ===
            "project-happy";

    assert(
        executionTargetPreserved,
        "Resolved project target was not persisted in ExecutionRequest.",
    );

    console.log({
        executionTargetPreserved:
            executionTargetPreserved,
    });
    const restoredVerification =
        approvedCase.verificationRequestId
            ? await restartedStore
                .verification()
                .get(
                    approvedCase.verificationRequestId,
                )
            : undefined;

    const restoredTasks =
        await restartedStore
            .task()
            .list();

    const restoredAudits =
        await restartedStore
            .audit()
            .list();

    assert(
        restoredCommand.length >= 2,
        "Persisted commands were not restored after restart.",
    );

    assert(
        restoredMission !==
            undefined,
        "Mission was not restored after restart.",
    );

    assert(
        restoredExecution !==
            undefined,
        "Execution state was not restored after restart.",
    );

    assert(
        restoredVerification !==
            undefined,
        "Verification state was not restored after restart.",
    );

    assert(
        restoredTasks.length >= 5,
        "Mission task graph was not persisted.",
    );

    assert(
        restoredAudits.length >= 1,
        "Audit state was not persisted.",
    );

    // ==============================================
    // TENANT ISOLATION
    // ==============================================

    const otherTenant =
        createHappyStateStore(
            restartedPersistence,
            "org-b",
            "workspace-b",
            "user-b",
        );

    const otherTenantCommands =
        await otherTenant
            .repository("COMMAND")
            .list();

    assert(
        otherTenantCommands.length === 0,
        "Cross-tenant command visibility detected.",
    );

    let crossTenantBlocked =
        false;

    const persistedCommandId =
        restoredCommand[0]?.id;

    assert(
        persistedCommandId !== undefined,
        "No persisted command ID available for isolation test.",
    );

    try {
        await otherTenant
            .repository("COMMAND")
            .get(
                persistedCommandId,
            );
    } catch (error) {
        crossTenantBlocked =
            error instanceof Error &&
            error.message ===
                "TENANT_ISOLATION_VIOLATION";
    }

    assert(
        crossTenantBlocked,
        "Cross-tenant direct read was not blocked.",
    );

    // ==============================================
    // CLEANUP
    // ==============================================

    if (existsSync(testDirectory)) {
        rmSync(
            testDirectory,
            {
                recursive: true,
                force: true,
            },
        );
    }

    console.log(
        "STEP 23 persistence integration test: PASS",
    );

    console.log({
        commandPersisted:
            restoredCommand.length >= 2,

        missionPersisted:
            restoredMission !==
            undefined,

        taskGraphPersisted:
            restoredTasks.length >= 5,

        executionPersisted:
            restoredExecution !==
            undefined,

        verificationPersisted:
            restoredVerification !==
            undefined,

        auditPersisted:
            restoredAudits.length >= 1,

        restartRecovery:
            true,

        tenantIsolation:
            true,

        crossTenantBlocked,

        approvalGate:
            approvalCase.status ===
            "WAITING_APPROVAL",

        fakeCompletionPrevented:
            approvedCase.status !==
            "COMPLETED",

        persistedFlag:
            approvedCase.persisted,
    });
}

main().catch(
    (error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    },
);







