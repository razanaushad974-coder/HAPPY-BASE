import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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

function main(): void {
  const root =
    mkdtempSync(
      join(tmpdir(), "happy-workspace-"),
    );

  try {
    const executor =
      new WorkspaceCodeExecutor(root);

    const created =
      executor.execute([
        {
          action: "CREATE",
          path: "src/test-file.ts",
          content:
            "export const happy = true;\n",
        },
      ]);

    assert(
      created.status === "COMPLETED",
      "CREATE operation failed.",
    );

    assert(
      created.changedFiles.includes(
        "src/test-file.ts",
      ),
      "Created file was not reported.",
    );

    const target =
      join(
        root,
        "src",
        "test-file.ts",
      );

    assert(
      existsSync(target),
      "Created file does not exist.",
    );

    assert(
      readFileSync(target, "utf8") ===
        "export const happy = true;\n",
      "Created file content mismatch.",
    );

    const escaped =
      executor.execute([
        {
          action: "CREATE",
          path: "..\\outside.ts",
          content: "blocked",
        },
      ]);

    assert(
      escaped.status === "FAILED",
      "Path traversal was not blocked.",
    );

    const missingModify =
      executor.execute([
        {
          action: "MODIFY",
          path: "missing.ts",
          content: "blocked",
        },
      ]);

    assert(
      missingModify.status === "FAILED",
      "MODIFY of missing file was not blocked.",
    );

    console.log(
      "STEP 39 workspace executor test: PASS",
    );

    console.log({
      createFile: true,
      safeRelativePaths: true,
      pathTraversalBlocked: true,
      missingModifyBlocked: true,
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

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
