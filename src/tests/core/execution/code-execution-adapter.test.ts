import { CodeExecutionAdapter } from "../../../core/execution/code-execution-adapter";
import type { ExecutionRequest } from "../../../core/execution/types";

function assert(
  condition: boolean,
  message: string,
): void {
  if (!condition) {
    throw new Error(message);
  }
}

function makeRequest(
  overrides: Partial<ExecutionRequest> = {},
): ExecutionRequest {
  return {
    id: "code-exec-test",
    taskId: "code-task-test",
    missionId: "code-mission-test",
    capability: "CODE",
    action: "MODIFY",
    input: {
      command:
        "modify HAPPY source safely",
    },
    requiresApproval: false,
    approved: true,
    risk: "LOW",
    createdAt:
      new Date().toISOString(),
    ...overrides,
  };
}

async function main(): Promise<void> {
  const adapter =
    new CodeExecutionAdapter();

  assert(
    adapter.status() ===
      "NOT_YET_CONNECTED",
    "CODE adapter must remain NOT_YET_CONNECTED until real workspace executor exists.",
  );

  assert(
    adapter.canExecute(
      makeRequest({
        action: "CREATE",
      }),
    ),
    "CREATE should route to CODE.",
  );

  assert(
    adapter.canExecute(
      makeRequest({
        action: "MODIFY",
      }),
    ),
    "MODIFY should route to CODE.",
  );

  assert(
    adapter.canExecute(
      makeRequest({
        action: "BUILD",
      }),
    ),
    "BUILD should route to CODE.",
  );

  assert(
    adapter.canExecute(
      makeRequest({
        action: "TEST",
      }),
    ),
    "TEST should route to CODE.",
  );

  const approval =
    await adapter.execute(
      makeRequest({
        requiresApproval: true,
        approved: false,
      }),
    );

  assert(
    approval.status ===
      "WAITING_APPROVAL",
    "Approval gate failed.",
  );

  const result =
    await adapter.execute(
      makeRequest(),
    );

  assert(
    result.status ===
      "NOT_YET_CONNECTED",
    "CODE adapter must not pretend to execute workspace changes.",
  );

  assert(
    result.output !== undefined,
    "CODE adapter contract output missing.",
  );

  console.log(
    "STEP 39 CODE execution adapter test: PASS",
  );

  console.log({
    actionRouting: true,
    approvalGate: true,
    safeExecutionContract: true,
    realWorkspaceMutationPrevented: true,
    notYetConnectedHonored: true,
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
