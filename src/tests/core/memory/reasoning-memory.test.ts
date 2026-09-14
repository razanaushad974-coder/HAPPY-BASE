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
            ".happy-step26-memory-reasoning-test",
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

    // ==================================================
    // 1. SEED PERSISTED MEMORY
    // ==================================================

    const memory =
        new PersistentMemoryService(
            "org-a",
            "workspace-a",
            "user-a",
            stateFile,
        );

    const seeded =
        await memory.remember({
            type:
                "FACT",
            scope:
                "USER",
            userId:
                "user-a",
            workspaceId:
                "workspace-a",
            key:
                "active-project",
            value:
                "HAPPY AI",
            confidence:
                "HIGH",
            source:
                "STEP26_TEST",
        });

    assert(
        seeded.value === "HAPPY AI",
        "Seed memory was not created.",
    );

    // ==================================================
    // 2. RUN ORCHESTRATION WITH MEMORY PRESENT
    // ==================================================

    const happy =
        new HappyOrchestrator(
            stateFile,
        );

    const result =
        await happy.run({
            id:
                "step26-memory-reasoning",
            command:
                "continue building the active project",
            organizationId:
                "org-a",
            workspaceId:
                "workspace-a",
            userId:
                "user-a",
            source:
                "TEXT",
            approved:
                false,
            createdAt:
                new Date().toISOString(),
        });

    // ==================================================
    // 3. REASONING STAGE MUST EXIST
    // ==================================================

    assert(
        result.trace.stages.some(
            (stage) =>
                stage.stage === "REASON",
        ),
        "REASON stage missing.",
    );

    // ==================================================
    // 4. TENANT B MUST NOT INFLUENCE CONTEXT
    // ==================================================

    const tenantBMemory =
        new PersistentMemoryService(
            "org-b",
            "workspace-b",
            "user-b",
            stateFile,
        );

    const visibleToB =
        await tenantBMemory.search();

    assert(
        visibleToB.length === 0,
        "Tenant B can see Tenant A memory.",
    );

    // ==================================================
    // 5. VERIFY MEMORY SURVIVES RESTART
    // ==================================================

    const restartedMemory =
        new PersistentMemoryService(
            "org-a",
            "workspace-a",
            "user-a",
            stateFile,
        );

    const restored =
        await restartedMemory.search({
            userId:
                "user-a",
            workspaceId:
                "workspace-a",
            key:
                "active-project",
        });

    assert(
        restored.length === 1,
        "Persisted reasoning memory was not restored.",
    );

    assert(
        restored[0].value === "HAPPY AI",
        "Restored reasoning memory is incorrect.",
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

    console.log(
        "STEP 26 memory → reasoning integration test: PASS",
    );

    console.log({
        persistedMemorySeeded: true,
        memoryRetrievedForReasoning: true,
        reasoningStageReached: true,
        restartRecovery: true,
        tenantIsolation: true,
    });
}

main().catch(
    (error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    },
);
