import {
  createDefaultExecutionRegistry,
} from "../../../core/execution/default-registry";

import {
  ExecutionEngine,
} from "../../../core/execution/engine";

async function main(): Promise<void> {
  const registry =
    createDefaultExecutionRegistry();

  const engine =
    new ExecutionEngine(registry);

  const baseRequest = {
    id: crypto.randomUUID(),
    taskId: crypto.randomUUID(),
    missionId: crypto.randomUUID(),
    action: "Create API implementation",
    input: {
      specification: "HAPPY API",
    },
    risk: "HIGH" as const,
    createdAt: new Date().toISOString(),
  };

  // -----------------------------------------------
  // APPROVAL GATE
  // -----------------------------------------------

  const unapprovedResult =
    await engine.execute({
      ...baseRequest,
      capability: "CODE",
      requiresApproval: true,
      approved: false,
    });

  if (
    unapprovedResult.status !==
    "WAITING_APPROVAL"
  ) {
    throw new Error(
      "Approval gate bypass detected.",
    );
  }

  // -----------------------------------------------
  // UNAVAILABLE ADAPTER
  // -----------------------------------------------

  const unavailableResult =
    await engine.execute({
      ...baseRequest,
      capability: "CODE",
      requiresApproval: false,
      approved: false,
    });

  if (
    unavailableResult.status !==
    "NOT_YET_CONNECTED"
  ) {
    throw new Error(
      "Unavailable adapter was not blocked.",
    );
  }

  // -----------------------------------------------
  // AI ADAPTER STATE
  // -----------------------------------------------

  const aiResult =
    await engine.execute({
      ...baseRequest,
      capability: "AI",
      requiresApproval: false,
      approved: false,
    });

  if (
    aiResult.status !==
    "NOT_YET_CONNECTED"
  ) {
    throw new Error(
      "AI adapter connection state failed.",
    );
  }

  // -----------------------------------------------
  // REGISTRY
  // -----------------------------------------------

  const adapters =
    registry.list();

  if (adapters.length !== 10) {
    throw new Error(
      "Default execution adapter registry is incomplete.",
    );
  }

  const unavailableCount =
    adapters.filter(
      (adapter) =>
        adapter.status() ===
        "NOT_YET_CONNECTED",
    ).length;

  if (unavailableCount !== 10) {
    throw new Error(
      "Unexpected adapter availability state.",
    );
  }

  // -----------------------------------------------
  // NO FAKE EXECUTION
  // -----------------------------------------------

  if (
    unavailableResult.output !==
    undefined
  ) {
    throw new Error(
      "Unavailable execution produced fake output.",
    );
  }

  console.log(
    "Execution adapter test: PASS",
  );

  console.log({
    adapters: adapters.length,
    unavailableAdapters:
      unavailableCount,
    approvalGate:
      unapprovedResult.status ===
      "WAITING_APPROVAL",
    unavailableExecution:
      unavailableResult.status ===
      "NOT_YET_CONNECTED",
    aiExecution:
      aiResult.status ===
      "NOT_YET_CONNECTED",
    fakeExecutionPrevented:
      unavailableResult.output ===
      undefined,
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
