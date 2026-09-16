import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";

import { join } from "node:path";
import { tmpdir } from "node:os";

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

function request(
  action: string,
  targetReference: object,
  input: unknown,
  overrides: Record<string, unknown> = {},
): any {
  return {
    id: `file-op-${action.toLowerCase()}`,
    taskId: "task-file-ops",
    missionId: "mission-file-ops",
    capability: "FILE",
    action,
    input,
    targetReference,
    requiresApproval: false,
    approved: true,
    risk: "LOW",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function main(): Promise<void> {
  const root =
    mkdtempSync(
      join(
        tmpdir(),
        "happy-file-ops-",
      ),
    );

  try {
    const executor =
      new WorkspaceCodeExecutor(root);

    const adapter =
      new FileExecutionAdapter(
        executor,
      );

    const target = {
      token: "file-ops",
      entityType: "FILE",
      entityId: "file-ops-001",
      confidence: "HIGH",
      source: "ACTIVE_CONTEXT",
    } as const;

    // CREATE
    const create =
      await adapter.execute(
        request(
          "CREATE",
          target,
          {
            operation: "CREATE",
            path: "src/original.ts",
            content:
              "export const value = 1;\n",
          },
        ),
      );

    assert(
      create.status === "COMPLETED",
      "CREATE failed.",
    );

    assert(
      existsSync(
        join(
          root,
          "src",
          "original.ts",
        ),
      ),
      "CREATE did not create file.",
    );

    // READ
    const read =
      await adapter.execute(
        request(
          "READ",
          target,
          {
            operation: "READ",
            path: "src/original.ts",
          },
        ),
      );

    assert(
      read.status === "COMPLETED",
      "READ failed.",
    );

    assert(
      (
        read.output as {
          content?: string;
        }
      ).content ===
        "export const value = 1;\n",
      "READ returned wrong content.",
    );

    // COPY
    const copy =
      await adapter.execute(
        request(
          "COPY",
          target,
          {
            operation: "COPY",
            path: "src/original.ts",
            destinationPath:
              "src/copied.ts",
          },
        ),
      );

    assert(
      copy.status === "COMPLETED",
      "COPY failed.",
    );

    assert(
      existsSync(
        join(
          root,
          "src",
          "copied.ts",
        ),
      ),
      "COPY did not create destination.",
    );

    // RENAME
    const rename =
      await adapter.execute(
        request(
          "RENAME",
          target,
          {
            operation: "RENAME",
            path: "src/copied.ts",
            destinationPath:
              "src/renamed.ts",
          },
      ));

    assert(
      rename.status === "COMPLETED",
      "RENAME failed.",
    );

    assert(
      !existsSync(
        join(
          root,
          "src",
          "copied.ts",
        ),
      ),
      "RENAME left source behind.",
    );

    assert(
      existsSync(
        join(
          root,
          "src",
          "renamed.ts",
        ),
      ),
      "RENAME destination missing.",
    );

    // MOVE
    const move =
      await adapter.execute(
        request(
          "MOVE",
          target,
          {
            operation: "MOVE",
            path: "src/renamed.ts",
            destinationPath:
              "moved/final.ts",
          },
      ));

    assert(
      move.status === "COMPLETED",
      "MOVE failed.",
    );

    assert(
      existsSync(
        join(
          root,
          "moved",
          "final.ts",
        ),
      ),
      "MOVE destination missing.",
    );

    // MODIFY
    const modify =
      await adapter.execute(
        request(
          "MODIFY",
          target,
          {
            operation: "MODIFY",
            path: "moved/final.ts",
            content:
              "export const value = 2;\n",
          },
      ));

    assert(
      modify.status === "COMPLETED",
      "MODIFY failed.",
    );

    assert(
      readFileSync(
        join(
          root,
          "moved",
          "final.ts",
        ),
        "utf8",
      ) ===
        "export const value = 2;\n",
      "MODIFY content mismatch.",
    );

    // DELETE
    const del =
      await adapter.execute(
        request(
          "DELETE",
          target,
          {
            operation: "DELETE",
            path: "moved/final.ts",
          },
        ),
      );

    assert(
      del.status === "COMPLETED",
      "DELETE failed.",
    );

    assert(
      !existsSync(
        join(
          root,
          "moved",
          "final.ts",
        ),
      ),
      "DELETE did not remove file.",
    );

    // Approval gate
    const approval =
      await adapter.execute(
        request(
          "CREATE",
          target,
          {
            operation: "CREATE",
            path: "src/approval-blocked.ts",
            content: "blocked",
          },
          {
            requiresApproval: true,
            approved: false,
            risk: "HIGH",
          },
        ),
      );

    assert(
      approval.status ===
        "WAITING_APPROVAL",
      "Approval gate bypassed.",
    );

    // Path safety
    const traversal =
      await adapter.execute(
        request(
          "READ",
          target,
          {
            operation: "READ",
            path:
              "..\\outside-secret.txt",
          },
        ),
      );

    assert(
      traversal.status ===
        "FAILED",
      "Path traversal was not rejected.",
    );

    // Shell guarantee
    const combined =
      [
        create,
        read,
        copy,
        rename,
        move,
        modify,
        del,
      ];

    assert(
      combined.every(
        (result) =>
          (
            result.output as {
              shellExecuted?: boolean;
            }
          )?.shellExecuted === false,
      ),
      "A file operation reported shell execution.",
    );

    console.log(
      "STEP 39 FILE operations test: PASS",
    );

    console.log({
      create: true,
      read: true,
      copy: true,
      rename: true,
      move: true,
      modify: true,
      delete: true,
      approvalGate: true,
      pathSafety: true,
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
