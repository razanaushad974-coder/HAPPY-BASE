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
    PersistentMemoryService,
} from "../../../core/memory/persistent-service";

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
            ".happy-step25-memory-test",
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
    // FIRST ORCHESTRATOR
    // ==============================================

    const happy =
        new HappyOrchestrator(
            stateFile,
        );

    const request = {
        id:
            "step25-memory-pipeline",
        command:
            "research the current HAPPY architecture",
        organizationId:
            "org-a",
        workspaceId:
            "workspace-a",
        userId:
            "user-a",
        source:
            "TEXT" as const,
        approved:
            false,
        createdAt:
            new Date().toISOString(),
    };

    const firstRun =
        await happy.run(request);

    assert(
        firstRun.trace.stages.some(
            (stage) =>
                stage.stage ===
                "MEMORY" &&
                stage.status ===
                "COMPLETED",
        ),
        "Persistent MEMORY stage did not complete.",
    );

    // ==============================================
    // MEMORY MUST EXIST AFTER PIPELINE RUN
    // ==============================================

    const memoryAfterRun =
        new PersistentMemoryService(
            "org-a",
            "workspace-a",
            "user-a",
            stateFile,
        );

    const storedMemories =
        await memoryAfterRun.search({
            userId:
                "user-a",
            workspaceId:
                "workspace-a",
            key:
                `pipeline:${request.id}`,
        });

    assert(
        storedMemories.length === 1,
        "Pipeline command was not stored in persistent memory.",
    );

    assert(
        storedMemories[0].value ===
            request.command,
        "Persisted pipeline memory contains the wrong command.",
    );

    const memoryId =
        storedMemories[0].id;

    // ==============================================
    // RESTART SIMULATION
    // ==============================================

    const restartedOrchestrator =
        new HappyOrchestrator(
            stateFile,
        );

    await restartedOrchestrator.run({
        ...request,
        id:
            "step25-second-run",
    });

    const restoredMemoryService =
        new PersistentMemoryService(
            "org-a",
            "workspace-a",
            "user-a",
            stateFile,
        );

    const restored =
        await restoredMemoryService.recall(
            memoryId,
        );

    assert(
        restored !== undefined,
        "Persistent memory was not restored after orchestration restart.",
    );

    assert(
        restored?.value ===
            request.command,
        "Restored memory value is incorrect.",
    );

    // ==============================================
    // TENANT B MUST NOT SEE TENANT A MEMORY
    // ==============================================

    const tenantB =
        new PersistentMemoryService(
            "org-b",
            "workspace-b",
            "user-b",
            stateFile,
        );

    const visibleToB =
        await tenantB.search();

    assert(
        visibleToB.length === 0,
        "Cross-tenant persistent memory became visible.",
    );

    let crossTenantBlocked =
        false;

    try {
        await tenantB.recall(
            memoryId,
        );
    } catch (error) {
        crossTenantBlocked =
            error instanceof Error &&
            error.message ===
                "TENANT_ISOLATION_VIOLATION";
    }

    assert(
        crossTenantBlocked,
        "Cross-tenant persistent memory read was not blocked.",
    );

    // ==============================================
    // DUPLICATE REQUEST MUST REUSE MEMORY
    // ==============================================

    const sameRequestMemories =
        await restoredMemoryService.search({
            userId:
                "user-a",
            workspaceId:
                "workspace-a",
            key:
                `pipeline:${request.id}`,
        });

    assert(
        sameRequestMemories.length === 1,
        "Pipeline memory deduplication failed.",
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
        "STEP 25 persistent orchestration memory test: PASS",
    );

    console.log({
        memoryStageCompleted: true,
        commandRemembered: true,
        persistentMemoryCreated: true,
        restartRecovery: true,
        restoredMemory: true,
        tenantIsolation: true,
        crossTenantBlocked,
        memoryDeduplication: true,
    });
}

main().catch(
    (error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    },
);
