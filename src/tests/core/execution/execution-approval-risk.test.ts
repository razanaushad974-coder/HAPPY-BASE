import { ExecutionEngine } from "../../../core/execution/engine";
import { ExecutionAdapterRegistry } from "../../../core/execution/registry";
import type { ExecutionAdapter, ExecutionRequest } from "../../../core/execution/types";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  let executions = 0;
  const registry = new ExecutionAdapterRegistry();
  const adapter: ExecutionAdapter = {
    capability: "CODE",
    status: () => "AVAILABLE",
    canExecute: () => true,
    async execute(request) {
      executions += 1;
      return {
        id: `result-${request.id}`,
        requestId: request.id,
        capability: request.capability,
        status: "COMPLETED",
        evidenceIds: [],
        startedAt: new Date().toISOString(),
        completedAt: new Date().toISOString(),
      };
    },
  };
  registry.register(adapter);
  const engine = new ExecutionEngine(registry);

  const base: Omit<ExecutionRequest, "action" | "risk" | "requiresApproval" | "approved"> = {
    id: "request-1",
    taskId: "task-1",
    missionId: "mission-1",
    capability: "CODE",
    input: {},
    createdAt: new Date().toISOString(),
  };

  const attacks: Array<Pick<ExecutionRequest, "action" | "risk" | "requiresApproval" | "approved">> = [
    { action: "DELETE", risk: "LOW", requiresApproval: false, approved: false },
    { action: "DB_UPDATE", risk: "LOW", requiresApproval: false, approved: false },
    { action: "GET", risk: "MEDIUM", requiresApproval: false, approved: false },
    { action: "BUILD", risk: "HIGH", requiresApproval: false, approved: false },
  ];

  for (const [index, attack] of attacks.entries()) {
    const result = await engine.execute({ ...base, ...attack, id: `attack-${index}` });
    assert(result.status === "WAITING_APPROVAL", `Approval downgrade bypassed for ${attack.action}/${attack.risk}.`);
  }

  assert(executions === 0, "Adapter executed despite missing required approval.");

  const readOnly = await engine.execute({
    ...base,
    id: "read-only",
    action: "GET",
    risk: "LOW",
    requiresApproval: false,
    approved: false,
  });
  assert(readOnly.status === "COMPLETED", "Low-risk read-only operation should remain executable.");
  assert(executions === 1, "Expected exactly one low-risk execution.");

  console.log("Execution engine approval downgrade regression test: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
