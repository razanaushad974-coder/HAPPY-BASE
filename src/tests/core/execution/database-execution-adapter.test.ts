import type {
  AdapterStatus,
  ExecutionRequest,
} from "../../../core/execution/types";

import {
  DatabaseExecutionAdapter,
  type DatabaseExecutionInput,
  type DatabaseProvider,
} from "../../../core/execution/database-execution-adapter";

import {
  ExecutionAdapterRegistry,
} from "../../../core/execution/registry";

import {
  ExecutionEngine,
} from "../../../core/execution/engine";

function request(
  input: unknown,
  overrides: Partial<ExecutionRequest> = {},
): ExecutionRequest {
  return {
    id: crypto.randomUUID(),
    taskId: "task-db-1",
    missionId: "mission-db-1",
    capability: "DATABASE",
    action: "DB_SELECT",
    input,
    requiresApproval: false,
    approved: true,
    risk: "MEDIUM",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

class FakeDatabaseProvider
  implements DatabaseProvider {
  private readonly executed: DatabaseExecutionInput[] = [];

  status(): AdapterStatus {
    return "AVAILABLE";
  }

  async execute(
    input: DatabaseExecutionInput,
  ): Promise<unknown> {
    this.executed.push(input);

    return {
      rows: [
        {
          id: "row-1",
          organizationId:
            input.scope.organizationId,
          workspaceId:
            input.scope.workspaceId,
        },
      ],
      rowCount: 1,
    };
  }

  get executions(): DatabaseExecutionInput[] {
    return [...this.executed];
  }
}

async function main(): Promise<void> {
  // --------------------------------------------------
  // NOT-YET-CONNECTED BEHAVIOR
  // --------------------------------------------------

  const disconnected =
    new DatabaseExecutionAdapter();

  if (
    disconnected.status() !==
    "NOT_YET_CONNECTED"
  ) {
    throw new Error(
      "Database adapter must remain NOT_YET_CONNECTED without a provider.",
    );
  }

  const disconnectedResult =
    await disconnected.execute(
      request({
        action: "DB_SELECT",
        resource: "users",
        scope: {
          organizationId: "org-a",
          workspaceId: "ws-a",
        },
      }),
    );

  if (
    disconnectedResult.status !==
    "NOT_YET_CONNECTED"
  ) {
    throw new Error(
      "Disconnected database execution did not return NOT_YET_CONNECTED.",
    );
  }

  // --------------------------------------------------
  // FAKE PROVIDER CONTRACT TEST
  // --------------------------------------------------

  const provider =
    new FakeDatabaseProvider();

  const connected =
    new DatabaseExecutionAdapter(provider);

  if (connected.status() !== "AVAILABLE") {
    throw new Error(
      "Injected test provider should make adapter AVAILABLE.",
    );
  }

  const readInput = {
    action: "DB_SELECT" as const,
    resource: "users",
    scope: {
      organizationId: "org-a",
      workspaceId: "ws-a",
      userId: "user-a",
    },
    limit: 10,
  };

  const readResult =
    await connected.execute(
      request(readInput),
    );

  if (readResult.status !== "COMPLETED") {
    throw new Error(
      "Database SELECT did not complete against the test provider.",
    );
  }

  if (!readResult.output) {
    throw new Error(
      "Database SELECT returned no output.",
    );
  }

  if (
    provider.executions.length !== 1
  ) {
    throw new Error(
      "Unexpected provider execution count.",
    );
  }

  if (
    provider.executions[0].scope.organizationId !==
      "org-a" ||
    provider.executions[0].scope.workspaceId !==
      "ws-a"
  ) {
    throw new Error(
      "Database tenant scope was not propagated correctly.",
    );
  }

  // --------------------------------------------------
  // TENANT SCOPE MUST EXIST
  // --------------------------------------------------

  const missingTenant =
    await connected.execute(
      request({
        action: "DB_SELECT",
        resource: "users",
        scope: {
          organizationId: "",
          workspaceId: "ws-a",
        },
      }),
    );

  if (
    missingTenant.status !==
    "BLOCKED"
  ) {
    throw new Error(
      "Missing tenant scope must be blocked.",
    );
  }

  // --------------------------------------------------
  // WRITE APPROVAL
  // --------------------------------------------------

  const writeWaiting =
    await connected.execute(
      request(
        {
          action: "DB_UPDATE",
          resource: "users",
          scope: {
            organizationId: "org-a",
            workspaceId: "ws-a",
          },
          values: {
            displayName: "Updated",
          },
        },
        {
          action: "DB_UPDATE",
          requiresApproval: true,
          approved: false,
          risk: "HIGH",
        },
      ),
    );

  if (
    writeWaiting.status !==
    "WAITING_APPROVAL"
  ) {
    throw new Error(
      "Database write without approval must wait for approval.",
    );
  }

  // --------------------------------------------------
  // BAD INPUT
  // --------------------------------------------------

  if (
    connected.canExecute(
      request({
        action: "DB_SELECT",
      }),
    )
  ) {
    throw new Error(
      "Invalid database input was accepted by canExecute().",
    );
  }

  // --------------------------------------------------
  // EXECUTION ENGINE ROUTING
  // --------------------------------------------------

  const registry =
    new ExecutionAdapterRegistry();

  registry.register(
    new DatabaseExecutionAdapter(provider),
  );

  const engine =
    new ExecutionEngine(registry);

  const engineResult =
    await engine.execute(
      request(readInput),
    );

  if (
    engineResult.status !==
    "COMPLETED"
  ) {
    throw new Error(
      "ExecutionEngine did not route to DATABASE adapter correctly.",
    );
  }

  console.log(
    "Database execution adapter test: PASS",
  );

  console.log({
    disconnectedStatus:
      disconnected.status(),
    connectedStatus:
      connected.status(),
    selectExecution:
      readResult.status,
    tenantGuard:
      missingTenant.status,
    writeApproval:
      writeWaiting.status,
    engineRouting:
      engineResult.status,
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
