import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  WorkspaceCodeExecutor,
} from "../../../core/execution/workspace-code-executor";

import {
  CodeExecutionAdapter,
} from "../../../core/execution/code-execution-adapter";

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
      join(tmpdir(), "happy-code-adapter-"),
    );

  try {
    const executor =
      new WorkspaceCodeExecutor(root);

    const adapter =
      new CodeExecutionAdapter(
        executor,
      );

    assert(
      adapter.status() ===
        "AVAILABLE",
      "CODE adapter should be AVAILABLE with WorkspaceCodeExecutor.",
    );

    const result =
      await adapter.execute({
        id:
          "code-live-test",
        taskId:
          "code-task-live",
        missionId:
          "code-mission-live",
        capability:
          "CODE",
        action:
          "CREATE",
        input: {
          changes: [
            {
              action:
                "CREATE",
              path:
                "src/live-test.ts",
              content:
                "export const happyLive = true;\n",
            },
          ],
        },
        requiresApproval:
          false,
        approved:
          true,
        risk:
          "LOW",
        createdAt:
          new Date().toISOString(),
      });

    assert(
      result.status ===
        "COMPLETED",
      "CODE adapter did not complete workspace execution.",
    );

    const target =
      join(
        root,
        "src",
        "live-test.ts",
      );

    assert(
      existsSync(target),
      "Workspace file was not created.",
    );

    assert(
      readFileSync(
        target,
        "utf8",
      ) ===
        "export const happyLive = true;\n",
      "Workspace content mismatch.",
    );

    const approval =
      await adapter.execute({
        id:
          "code-approval-test",
        taskId:
          "code-task-approval",
        missionId:
          "code-mission-approval",
        capability:
          "CODE",
        action:
          "CREATE",
        input: {
          changes: [
            {
              action:
                "CREATE",
              path:
                "src/blocked.ts",
              content:
                "blocked",
            },
          ],
        },
        requiresApproval:
          true,
        approved:
          false,
        risk:
          "HIGH",
        createdAt:
          new Date().toISOString(),
      });

    assert(
      approval.status ===
        "WAITING_APPROVAL",
      "Approval gate was bypassed.",
    );

    console.log(
      "STEP 39 CODE adapter live workspace test: PASS",
    );

    console.log({
      adapterAvailable: true,
      workspaceExecutorConnected: true,
      fileCreated: true,
      outputVerified: true,
      approvalGate: true,
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
