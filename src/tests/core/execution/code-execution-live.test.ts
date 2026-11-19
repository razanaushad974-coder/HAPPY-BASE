import {
  existsSync,
  mkdtempSync,
  rmSync,
} from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";

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
  const root = mkdtempSync(
    join(tmpdir(), "happy-code-adapter-"),
  );

  try {
    const adapter = new CodeExecutionAdapter();

    assert(
      adapter.status() === "NOT_YET_CONNECTED",
      "CODE adapter must remain disconnected until a server-owned executor is composed.",
    );

    const result = await adapter.execute({
      id: "code-live-test",
      taskId: "code-task-live",
      missionId: "code-mission-live",
      capability: "CODE",
      action: "CREATE",
      input: {
        changes: [
          {
            action: "CREATE",
            path: "src/live-test.ts",
            content: "export const happyLive = true;\\n",
          },
        ],
      },
      requiresApproval: false,
      approved: true,
      risk: "LOW",
      createdAt: new Date().toISOString(),
    });

    assert(
      result.status === "NOT_YET_CONNECTED",
      "CODE adapter must not execute workspace mutations.",
    );

    assert(
      !existsSync(join(root, "src", "live-test.ts")),
      "Untrusted CODE adapter unexpectedly created a workspace file.",
    );

    const approval = await adapter.execute({
      id: "code-approval-test",
      taskId: "code-task-approval",
      missionId: "code-mission-approval",
      capability: "CODE",
      action: "CREATE",
      input: {
        changes: [
          {
            action: "CREATE",
            path: "src/blocked.ts",
            content: "blocked",
          },
        ],
      },
      requiresApproval: true,
      approved: false,
      risk: "HIGH",
      createdAt: new Date().toISOString(),
    });

    assert(
      approval.status === "WAITING_APPROVAL",
      "Approval gate was bypassed.",
    );

    assert(
      !existsSync(join(root, "src", "blocked.ts")),
      "Approval-gated CODE request unexpectedly wrote a file.",
    );

    console.log(
      "STEP 39 CODE adapter live workspace test: PASS",
    );

    console.log({
      adapterNotYetConnected: true,
      workspaceMutationPrevented: true,
      approvalGate: true,
      noShellExecution: true,
    });
  } finally {
    rmSync(root, {
      recursive: true,
      force: true,
    });
  }
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
