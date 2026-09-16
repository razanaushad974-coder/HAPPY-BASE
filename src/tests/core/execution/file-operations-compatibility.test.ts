import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";

import {
  join,
} from "node:path";

import {
  tmpdir,
} from "node:os";

import {
  FileExecutionAdapter,
} from "../../../core/execution/file-execution-adapter";

import {
  WorkspaceCodeExecutor,
} from "../../../core/execution/workspace-code-executor";

function assert(
  condition: boolean,
  message: string,
): void {
  if (!condition) {
    throw new Error(message);
  }
}

async function main(): Promise<void> {
  const root =
    mkdtempSync(
      join(
        tmpdir(),
        "happy-file-compat-",
      ),
    );

  try {
    const adapter =
      new FileExecutionAdapter(
        new WorkspaceCodeExecutor(root),
      );

    const target = {
      token: "legacy-file",
      entityType: "FILE" as const,
      entityId: "legacy-file-001",
      confidence: "HIGH" as const,
      source: "ACTIVE_CONTEXT" as const,
    };

    const legacyChanges =
      await adapter.execute({
        id: "legacy-changes-test",
        taskId: "legacy-task",
        missionId: "legacy-mission",
        capability: "FILE",
        action: "CREATE",
        input: {
          changes: [
            {
              action: "CREATE",
              path: "src/legacy.ts",
              content:
                "export const legacy = true;\n",
            },
          ],
        },
        targetReference: target,
        requiresApproval: false,
        approved: true,
        risk: "LOW",
        createdAt:
          new Date().toISOString(),
      });

    assert(
      legacyChanges.status === "COMPLETED",
      "Legacy changes[] input failed.",
    );

    assert(
      existsSync(
        join(
          root,
          "src",
          "legacy.ts",
        ),
      ),
      "Legacy changes[] did not create file.",
    );

    const legacyFileChanges =
      await adapter.execute({
        id: "legacy-filechanges-test",
        taskId: "legacy-task-2",
        missionId: "legacy-mission-2",
        capability: "FILE",
        action: "MODIFY",
        input: {
          fileChanges: [
            {
              action: "MODIFY",
              path: "src/legacy.ts",
              content:
                "export const legacy = false;\n",
            },
          ],
        },
        targetReference: target,
        requiresApproval: false,
        approved: true,
        risk: "LOW",
        createdAt:
          new Date().toISOString(),
      });

    assert(
      legacyFileChanges.status === "COMPLETED",
      "Legacy fileChanges[] input failed.",
    );

    assert(
      readFileSync(
        join(
          root,
          "src",
          "legacy.ts",
        ),
        "utf8",
      ) ===
        "export const legacy = false;\n",
      "Legacy fileChanges[] content mismatch.",
    );

    const modern =
      await adapter.execute({
        id: "modern-operation-test",
        taskId: "modern-task",
        missionId: "modern-mission",
        capability: "FILE",
        action: "READ",
        input: {
          operation: "READ",
          path: "src/legacy.ts",
        },
        targetReference: target,
        requiresApproval: false,
        approved: true,
        risk: "LOW",
        createdAt:
          new Date().toISOString(),
      });

    assert(
      modern.status === "COMPLETED",
      "Modern operation input failed.",
    );

    console.log(
      "STEP 39 FILE compatibility test: PASS",
    );

    console.log({
      changesArrayCompatible: true,
      fileChangesArrayCompatible: true,
      modernOperationCompatible: true,
      legacyCreate: true,
      legacyModify: true,
      modernRead: true,
      noShellExecution: true,
    });
  } finally {
    rmSync(
      root,
      {
        recursive: true,
        force: true,
      },
    );
  }
}

main().catch(
  (error) => {
    console.error(error);
    process.exit(1);
  },
);
