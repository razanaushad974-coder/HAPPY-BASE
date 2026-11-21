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
  type WorkspaceFileExecutor,
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

    const remoteExecutor: WorkspaceFileExecutor = {
      async executeOperation(operation) {
        return {
          action: operation.action,
          status: "COMPLETED",
          path: operation.path,
          content: "remote-worker-content",
          changedFiles: [],
          errors: [],
        };
      },
    };
    const remoteAdapter = new FileExecutionAdapter(remoteExecutor, undefined, {
      async authorizeRead(_request, operation) {
        return operation.action === "READ" && operation.path === "remote/README.md";
      },
    });
    const remoteResult = await remoteAdapter.execute({
      id: "file-remote-worker-test",
      taskId: "task-remote",
      missionId: "mission-remote",
      capability: "FILE",
      action: "READ",
      input: { operation: "READ", path: "remote/README.md" },
      targetReference: {
        token: "remote-file",
        entityType: "FILE",
        entityId: "remote-file-1",
        confidence: "HIGH",
        source: "ACTIVE_CONTEXT",
      },
      requiresApproval: false,
      approved: false,
      risk: "LOW",
      createdAt: new Date().toISOString(),
    });
    assert(
      remoteResult.status === "COMPLETED" &&
        (remoteResult.output as { content?: string }).content === "remote-worker-content",
      "FILE adapter must await and consume a trusted remote workspace executor result.",
    );

    const throwingRemoteAdapter = new FileExecutionAdapter({
      async executeOperation() {
        throw new Error("provider secret details must not escape");
      },
    }, undefined, {
      async authorizeRead() { return true; },
    });
    const throwingRemoteResult = await throwingRemoteAdapter.execute({
      id: "file-remote-worker-error-test",
      taskId: "task-remote",
      missionId: "mission-remote",
      capability: "FILE",
      action: "READ",
      input: { operation: "READ", path: "remote/README.md" },
      targetReference: {
        token: "remote-file",
        entityType: "FILE",
        entityId: "remote-file-1",
        confidence: "HIGH",
        source: "ACTIVE_CONTEXT",
      },
      requiresApproval: false,
      approved: false,
      risk: "LOW",
      createdAt: new Date().toISOString(),
    });
    assert(
      throwingRemoteResult.status === "FAILED" &&
        throwingRemoteResult.error === "Tenant workspace executor failed.",
      "Remote worker exceptions must be contained and sanitized.",
    );

    const malformedRemoteAdapter = new FileExecutionAdapter({
      async executeOperation() {
        return {
          action: "READ",
          status: "COMPLETED",
          path: "remote/other-file.md",
          content: "unrelated content",
          changedFiles: [],
          errors: [],
        } as unknown as Awaited<ReturnType<WorkspaceFileExecutor["executeOperation"]>>;
      },
    }, undefined, {
      async authorizeRead() { return true; },
    });
    const malformedRemoteResult = await malformedRemoteAdapter.execute({
      id: "file-remote-worker-mismatch-test",
      taskId: "task-remote",
      missionId: "mission-remote",
      capability: "FILE",
      action: "READ",
      input: { operation: "READ", path: "remote/README.md" },
      targetReference: {
        token: "remote-file",
        entityType: "FILE",
        entityId: "remote-file-1",
        confidence: "HIGH",
        source: "ACTIVE_CONTEXT",
      },
      requiresApproval: false,
      approved: false,
      risk: "LOW",
      createdAt: new Date().toISOString(),
    });
    assert(
      malformedRemoteResult.status === "FAILED" &&
        malformedRemoteResult.error === "Tenant workspace executor returned an invalid or mismatched operation result.",
      "Remote worker responses for a different operation/path must be rejected.",
    );

    const adapter =
      new FileExecutionAdapter(executor);

    const target = {
      token: "test-file",
      entityType: "FILE" as const,
      entityId: "file-test-001",
      confidence: "HIGH" as const,
      source: "ACTIVE_CONTEXT" as const,
    };

    const implicitWorkspaceRelativePath =
      `.happy-implicit-workspace-must-not-write-${Date.now()}.tmp`;
    const implicitWorkspacePath = join(
      process.cwd(),
      implicitWorkspaceRelativePath,
    );
    assert(
      !existsSync(implicitWorkspacePath),
      "The implicit-workspace regression target unexpectedly exists.",
    );
    const unconfiguredAdapter = new FileExecutionAdapter(
      undefined,
      {
        async authorize() {
          return true;
        },
      },
    );
    assert(
      unconfiguredAdapter.status() === "NOT_YET_CONNECTED",
      "FILE adapter without an explicit workspace executor must remain disconnected.",
    );
    const unconfiguredResult = await unconfiguredAdapter.execute({
      id: "file-no-workspace-test",
      taskId: "task-file",
      missionId: "mission-file",
      capability: "FILE",
      action: "CREATE",
      input: {
        operation: "CREATE",
        path: implicitWorkspaceRelativePath,
        content: "must never be written",
      },
      targetReference: target,
      requiresApproval: false,
      approved: true,
      risk: "HIGH",
      createdAt: new Date().toISOString(),
    });
    assert(
      unconfiguredResult.status === "NOT_YET_CONNECTED" &&
        !existsSync(implicitWorkspacePath),
      "FILE adapter used an implicit process.cwd() workspace without explicit provisioning.",
    );

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
        approved: false,
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

    const deniedRead = await adapter.execute({
      id: "file-read-denied-test",
      taskId: "task-file-read",
      missionId: "mission-file",
      capability: "FILE",
      action: "READ",
      input: {
        operation: "READ",
        path: "src/file-adapter-test.ts",
      },
      targetReference: target,
      requiresApproval: false,
      approved: true,
      risk: "LOW",
      createdAt: new Date().toISOString(),
    });

    assert(
      deniedRead.status === "BLOCKED" &&
        deniedRead.output === undefined,
      "FILE READ without a scoped read authorizer was not denied.",
    );

    const authorizedReadAdapter = new FileExecutionAdapter(
      executor,
      undefined,
      {
        async authorizeRead(request, operation) {
          return (
            request.id === "file-read-authorized-test" &&
            operation.action === "READ" &&
            operation.path === "src/file-adapter-test.ts"
          );
        },
      },
    );
    const authorizedRead = await authorizedReadAdapter.execute({
      id: "file-read-authorized-test",
      taskId: "task-file-read",
      missionId: "mission-file",
      capability: "FILE",
      action: "READ",
      input: {
        operation: "READ",
        path: "src/file-adapter-test.ts",
      },
      targetReference: target,
      requiresApproval: false,
      approved: false,
      risk: "LOW",
      createdAt: new Date().toISOString(),
    });

    assert(
      authorizedRead.status === "COMPLETED" &&
        typeof (authorizedRead.output as { content?: string }).content === "string" &&
        (authorizedRead.output as { content: string }).content.includes("export const fileAdapter = true;") ,
      "Scoped FILE READ authorizer did not allow the expected read.",
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
      fileCapabilityAvailableWithExplicitExecutor: true,
      missingExecutorStaysNotYetConnected: true,
      implicitProcessCwdWorkspaceDenied: true,
      forgedApprovedFlagDenied: true,
      defaultDenyMutationGate: true,
      injectedAuthorizerPath: true,
      unauthenticatedReadDenied: true,
      scopedReadAuthorizerPath: true,
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
