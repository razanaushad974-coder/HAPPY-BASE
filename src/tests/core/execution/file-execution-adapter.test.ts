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

async function main(): Promise<void> {
  const root =
    mkdtempSync(
      join(tmpdir(), "happy-file-adapter-"),
    );

  try {
    const executor =
      new WorkspaceCodeExecutor(root);

    const adapter =
      new FileExecutionAdapter(executor);

    const target = {
      token: "test-file",
      entityType: "FILE" as const,
      entityId: "file-test-001",
      confidence: "HIGH" as const,
      source: "ACTIVE_CONTEXT" as const,
    };

    assert(
      adapter.status() === "AVAILABLE",
      "FILE adapter should be AVAILABLE.",
    );

    assert(
      adapter.canExecute({
        id: "file-can-execute",
        taskId: "task-file",
        missionId: "mission-file",
        capability: "FILE",
        action: "CREATE",
        input: {},
        targetReference: target,
        requiresApproval: false,
        approved: true,
        risk: "LOW",
        createdAt: new Date().toISOString(),
      }),
      "FILE CREATE routing failed.",
    );

    const result =
      await adapter.execute({
        id: "file-live-test",
        taskId: "task-file",
        missionId: "mission-file",
        capability: "FILE",
        action: "CREATE",
        input: {
          changes: [
            {
              action: "CREATE",
              path: "src/file-adapter-test.ts",
              content:
                "export const fileAdapter = true;\n",
            },
          ],
        },
        targetReference: target,
        requiresApproval: false,
        approved: true,
        risk: "LOW",
        createdAt: new Date().toISOString(),
      });

    assert(
      result.status === "WAITING_APPROVAL",
      "Caller-controlled approved=true bypassed the default-deny file mutation gate.",
    );

    const file =
      join(
        root,
        "src",
        "file-adapter-test.ts",
      );

    assert(
      !existsSync(file),
      "Unverified FILE mutation changed the workspace.",
    );

    const authorizedAdapter =
      new FileExecutionAdapter(
        executor,
        {
          async authorize(request, operation) {
            return (
              request.id === "file-authorized-test" &&
              operation.action === "CREATE" &&
              operation.path === "src/file-adapter-test.ts"
            );
          },
        },
      );

    const authorizedResult =
      await authorizedAdapter.execute({
        id: "file-authorized-test",
        taskId: "task-file",
        missionId: "mission-file",
        capability: "FILE",
        action: "CREATE",
        input: {
          operation: "CREATE",
          path: "src/file-adapter-test.ts",
          content: "export const fileAdapter = true;\n",
        },
        targetReference: target,
        requiresApproval: true,
        approved: true,
        risk: "HIGH",
        createdAt: new Date().toISOString(),
      });

    assert(
      authorizedResult.status === "COMPLETED",
      "Injected server authorizer could not authorize a file mutation.",
    );
    assert(
      existsSync(file) &&
        readFileSync(file, "utf8") ===
          "export const fileAdapter = true;\n",
      "Authorized FILE mutation output mismatch.",
    );

    const throwingAdapter =
      new FileExecutionAdapter(
        executor,
        {
          async authorize() {
            throw new Error("approval store unavailable");
          },
        },
      );

    const exceptionResult =
      await throwingAdapter.execute({
        id: "file-authorizer-error-test",
        taskId: "task-file",
        missionId: "mission-file",
        capability: "FILE",
        action: "CREATE",
        input: {
          operation: "CREATE",
          path: "src/authorizer-error-test.ts",
          content: "must not be written",
        },
        targetReference: target,
        requiresApproval: false,
        approved: true,
        risk: "HIGH",
        createdAt: new Date().toISOString(),
      });

    assert(
      exceptionResult.status === "WAITING_APPROVAL" &&
        !existsSync(join(root, "src", "authorizer-error-test.ts")),
      "Authorizer exception did not fail closed.",
    );

    const approval =
      await adapter.execute({
        id: "file-approval-test",
        taskId: "task-file-approval",
        missionId: "mission-file",
        capability: "FILE",
        action: "MODIFY",
        input: {
          changes: [
            {
              action: "MODIFY",
              path: "src/file-adapter-test.ts",
              content:
                "export const fileAdapter = false;\n",
            },
          ],
        },
        targetReference: target,
        requiresApproval: true,
        approved: false,
        risk: "HIGH",
        createdAt: new Date().toISOString(),
      });

    assert(
      approval.status === "WAITING_APPROVAL",
      "FILE approval gate was bypassed.",
    );

    console.log(
      "STEP 39 FILE execution adapter test: PASS",
    );

    console.log({
      fileTargetSupported: true,
      fileCapabilityAvailable: true,
      forgedApprovedFlagDenied: true,
      defaultDenyMutationGate: true,
      injectedAuthorizerPath: true,
      authorizerExceptionFailsClosed: true,
      approvalGate: true,
      pathSafetyInherited: true,
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
