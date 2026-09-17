import { resolveExecutionCapability } from "../../../core/execution/capability-resolver";

const databaseCases = [
    ["DB_SELECT", "DATABASE"],
    ["DB_QUERY", "DATABASE"],
    ["DB_INSERT", "DATABASE"],
    ["DB_UPDATE", "DATABASE"],
    ["DB_DELETE", "DATABASE"],
    ["DB_TRANSACTION", "DATABASE"],
] as const;

for (const [action, expected] of databaseCases) {
    const actual = resolveExecutionCapability(action);

    if (actual !== expected) {
        throw new Error(
            `${action} resolved to ${actual}; expected ${expected}.`,
        );
    }
}

const fileCapability = resolveExecutionCapability(
    "MODIFY",
    {
        token: "file",
        entityType: "FILE",
        entityId: "file-1",
        confidence: "HIGH",
        source: "ACTIVE_CONTEXT",
    },
);

if (fileCapability !== "FILE") {
    throw new Error(
        "Existing FILE routing regressed.",
    );
}

const apiCapability = resolveExecutionCapability("POST");

if (apiCapability !== "API") {
    throw new Error(
        "Existing API routing regressed.",
    );
}

console.log("Database routing test: PASS");

console.log({
    databaseActions: databaseCases.length,
    databaseCapability: "DATABASE",
    fileRoutingPreserved: fileCapability,
    apiRoutingPreserved: apiCapability,
});
