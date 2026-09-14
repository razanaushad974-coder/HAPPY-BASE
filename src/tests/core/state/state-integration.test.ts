import { join } from "node:path";
import { existsSync, rmSync } from "node:fs";

import { JsonFileStateAdapter } from "../../../core/persistence/adapters/json-file-adapter";
import { PersistenceService } from "../../../core/persistence/service";
import { createHappyStateStore } from "../../../core/state/factory";

async function main(): Promise<void> {
    const testDirectory = join(
        process.cwd(),
        ".happy-test-state-integration",
    );

    const stateFile = join(
        testDirectory,
        "state.json",
    );

    if (existsSync(testDirectory)) {
        rmSync(testDirectory, {
            recursive: true,
            force: true,
        });
    }

    // --------------------------------------------------
    // TENANT A
    // --------------------------------------------------

    const adapter = new JsonFileStateAdapter(stateFile);
    const persistence = new PersistenceService(adapter);

    const tenantA = createHappyStateStore(
        persistence,
        "org-a",
        "workspace-a",
        "user-a",
    );

    const tenantB = createHappyStateStore(
        persistence,
        "org-b",
        "workspace-b",
        "user-b",
    );

    const missionA = await tenantA.mission().create(
        "mission-a",
        {
            goal: "Build HAPPY",
            status: "PLANNED",
        },
        "user-a",
    );

    // --------------------------------------------------
    // SCOPED READ
    // --------------------------------------------------

    const fetchedA =
        await tenantA.mission().get("mission-a");

    if (!fetchedA) {
        throw new Error("Tenant A could not read its own mission.");
    }

    // --------------------------------------------------
    // TENANT B MUST NOT SEE A
    // --------------------------------------------------

    const visibleToB =
        await tenantB.mission().list();

    let crossTenantBlocked = false;

    try {
        await tenantB.mission().get("mission-a");
    } catch (error) {
        crossTenantBlocked =
            error instanceof Error &&
            error.message ===
                "TENANT_ISOLATION_VIOLATION";
    }

    // --------------------------------------------------
    // UPDATE
    // --------------------------------------------------

    const updatedA =
        await tenantA.mission().update(
            "mission-a",
            {
                goal:
                    "Build HAPPY — persistent core",
                status: "RUNNING",
            },
        );

    // --------------------------------------------------
    // RESTART SIMULATION
    // --------------------------------------------------

    const adapterAfterRestart =
        new JsonFileStateAdapter(stateFile);

    const persistenceAfterRestart =
        new PersistenceService(
            adapterAfterRestart,
        );

    const tenantAAfterRestart =
        createHappyStateStore(
            persistenceAfterRestart,
            "org-a",
            "workspace-a",
            "user-a",
        );

    const restored =
        await tenantAAfterRestart
            .mission()
            .get("mission-a") as
            | {
                id: string;
                entityType: "MISSION";
                version: number;
                createdAt: string;
                updatedAt: string;
                data: {
                    goal: string;
                    status: string;
                };
                organizationId: string;
                workspaceId: string;
                userId?: string;
            }
            | undefined;

    if (!restored) {
        throw new Error(
            "Scoped persistent mission was not restored.",
        );
    }

    // --------------------------------------------------
    // DELETE
    // --------------------------------------------------

    const deletedA =
        await tenantAAfterRestart
            .mission()
            .delete("mission-a");

    const afterDelete =
        await tenantAAfterRestart
            .mission()
            .get("mission-a");

    // --------------------------------------------------
    // FINAL ASSERTIONS
    // --------------------------------------------------

    const pass =
        missionA.organizationId === "org-a" &&
        missionA.workspaceId === "workspace-a" &&
        missionA.userId === "user-a" &&
        fetchedA.organizationId === "org-a" &&
        visibleToB.length === 0 &&
        crossTenantBlocked &&
        updatedA.version === 2 &&
        restored.version === 2 &&
        restored.data.status === "RUNNING" &&
        deletedA &&
        afterDelete === undefined;

    if (!pass) {
        throw new Error(
            "STEP 18 STATE INTEGRATION TEST FAILED",
        );
    }

    if (existsSync(testDirectory)) {
        rmSync(testDirectory, {
            recursive: true,
            force: true,
        });
    }

    console.log(
        "STEP 18 state integration test: PASS",
    );

    console.log({
        scopedCreate: true,
        tenantAIsolation: true,
        tenantBIsolation: true,
        crossTenantBlocked,
        persistentRepository: true,
        restartRecovery: true,
        versionIncrement:
            updatedA.version === 2,
        deletePersistence:
            afterDelete === undefined,
    });
}

main().catch((error: unknown) => {
    console.error(error);
    process.exitCode = 1;
});

