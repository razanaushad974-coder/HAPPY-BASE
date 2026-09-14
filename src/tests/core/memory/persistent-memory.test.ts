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
            ".happy-step24-memory-test",
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

    // ==================================================
    // TENANT A
    // ==================================================

    const tenantA =
        new PersistentMemoryService(
            "org-a",
            "workspace-a",
            "user-a",
            stateFile,
        );

    const created =
        await tenantA.remember({
            type:
                "FACT",

            scope:
                "USER",

            userId:
                "user-a",

            workspaceId:
                "workspace-a",

            key:
                "project-name",

            value:
                "HAPPY AI",

            confidence:
                "HIGH",

            source:
                "STEP24_TEST",
        });

    assert(
        created.id.startsWith("mem_"),
        "Memory ID was not generated.",
    );

    assert(
        (await tenantA.count()) === 1,
        "Memory count is incorrect.",
    );

    // ==================================================
    // RECALL
    // ==================================================

    const recalled =
        await tenantA.recall(
            created.id,
        );

    assert(
        recalled !== undefined,
        "Created memory could not be recalled.",
    );

    assert(
        recalled?.value ===
            "HAPPY AI",
        "Recalled value is incorrect.",
    );

    // ==================================================
    // SEARCH
    // ==================================================

    const searched =
        await tenantA.search({
            text:
                "HAPPY",
        });

    assert(
        searched.length === 1,
        "Persistent memory search failed.",
    );

    // ==================================================
    // UPDATE
    // ==================================================

    const updated =
        await tenantA.update(
            created.id,
            {
                value:
                    "HAPPY AI Persistent Memory",
                confidence:
                    "HIGH",
            },
        );

    assert(
        updated.value ===
            "HAPPY AI Persistent Memory",
        "Persistent memory update failed.",
    );

    // ==================================================
    // RESTART
    // ==================================================

    const tenantAAfterRestart =
        new PersistentMemoryService(
            "org-a",
            "workspace-a",
            "user-a",
            stateFile,
        );

    const restored =
        await tenantAAfterRestart.recall(
            created.id,
        );

    assert(
        restored !== undefined,
        "Memory was not restored after restart.",
    );

    assert(
        restored?.value ===
            "HAPPY AI Persistent Memory",
        "Updated memory was not restored.",
    );

    // ==================================================
    // TENANT B
    // ==================================================

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
        "Cross-tenant memory became visible.",
    );

    let crossTenantBlocked =
        false;

    try {
        await tenantB.recall(
            created.id,
        );
    } catch (error) {
        crossTenantBlocked =
            error instanceof Error &&
            error.message ===
                "TENANT_ISOLATION_VIOLATION";
    }

    assert(
        crossTenantBlocked,
        "Cross-tenant memory read was not blocked.",
    );

    // ==================================================
    // DELETE
    // ==================================================

    const deleted =
        await tenantAAfterRestart.forget(
            created.id,
        );

    assert(
        deleted,
        "Persistent memory delete failed.",
    );

    const afterDelete =
        await tenantAAfterRestart.recall(
            created.id,
        );

    assert(
        afterDelete === undefined,
        "Deleted memory still exists.",
    );

    // ==================================================
    // CLEANUP
    // ==================================================

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
        "STEP 24 persistent memory test: PASS",
    );

    console.log({
        memoryCreated: true,
        memoryRecalled: true,
        memorySearch: true,
        memoryUpdated: true,
        restartRecovery: true,
        tenantIsolation: true,
        crossTenantBlocked,
        memoryDeleted: true,
    });
}

main().catch(
    (error: unknown) => {
        console.error(error);
        process.exitCode = 1;
    },
);
