import {
    existsSync,
    rmSync,
} from "node:fs";

import {
    join,
} from "node:path";

import {
    PersistentMemoryService,
} from "../../../core/memory/persistent-service";

import {
    buildContext,
} from "../../../core/context/resolver";

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
            ".happy-step27-context-memory-test",
        );

    const stateFile =
        join(
            testDirectory,
            "memory-state.json",
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
    // TENANT A — PROJECT MEMORY
    // ==============================================

    const memoryA =
        new PersistentMemoryService(
            "org-a",
            "workspace-a",
            "user-a",
            stateFile,
        );

    await memoryA.remember({
        type:
            "PROJECT",
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
            "STEP27_TEST",
    });

    // ==============================================
    // TENANT A — MISSION MEMORY
    // ==============================================

    await memoryA.remember({
        type:
            "MISSION",
        scope:
            "USER",
        userId:
            "user-a",
        workspaceId:
            "workspace-a",
        key:
            "active-mission",
        value:
            "Build persistent HAPPY runtime",
        confidence:
            "HIGH",
        source:
            "STEP27_TEST",
    });

    const records =
        await memoryA.search({
            userId:
                "user-a",
            workspaceId:
                "workspace-a",
            limit:
                20,
        });

    assert(
        records.length === 2,
        "Expected two persisted context memories.",
    );

    const memorySummary =
        records
            .map(
                (memory) =>
                    `${memory.key}: ${memory.value}`,
            )
            .join("\n");

    // ==============================================
    // BUILD CONTEXT
    // ==============================================

    const context =
        buildContext({
            userId:
                "user-a",
            workspaceId:
                "workspace-a",
            memorySummary,
        });

    assert(
        context.referencedEntities.length === 1,
        "Persistent memory was not materialized into context.",
    );

    assert(
        context.referencedEntities[0].key ===
            "persistentMemory",
        "Persistent memory context item is missing.",
    );

    assert(
        context.referencedEntities[0].source ===
            "MEMORY",
        "Context memory source is incorrect.",
    );

    assert(
        context.referencedEntities[0].value.includes(
            "active-project: HAPPY AI",
        ),
        "Project memory was not included in context.",
    );

    assert(
        context.referencedEntities[0].value.includes(
            "active-mission: Build persistent HAPPY runtime",
        ),
        "Mission memory was not included in context.",
    );

    // ==============================================
    // TENANT B ISOLATION
    // ==============================================

    const memoryB =
        new PersistentMemoryService(
            "org-b",
            "workspace-b",
            "user-b",
            stateFile,
        );

    const visibleToB =
        await memoryB.search();

    assert(
        visibleToB.length === 0,
        "Tenant B can see Tenant A memory.",
    );

    // ==============================================
    // RESTART RECOVERY
    // ==============================================

    const restartedA =
        new PersistentMemoryService(
            "org-a",
            "workspace-a",
            "user-a",
            stateFile,
        );

    const restored =
        await restartedA.search({
            userId:
                "user-a",
            workspaceId:
                "workspace-a",
        });

    assert(
        restored.length === 2,
        "Persistent context memory was not restored.",
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
        "STEP 27 memory → context test: PASS",
    );

    console.log({
        projectMemoryPersisted: true,
        missionMemoryPersisted: true,
        memoryRetrieved: true,
        persistentMemoryMaterialized: true,
        projectMemoryInContext: true,
        missionMemoryInContext: true,
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
