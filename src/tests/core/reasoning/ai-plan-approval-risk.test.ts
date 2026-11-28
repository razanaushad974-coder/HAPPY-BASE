import { ReasoningEngine } from "../../../core/reasoning/engine";
import type { AIGateway } from "../../../core/ai/gateway";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const gateway = {
    complete: async () => ({
      success: true,
      provider: "GEMINI" as const,
      status: "COMPLETED" as const,
      requestId: "test-request",
      content: JSON.stringify({
        steps: [
          {
            order: 1,
            action: "GET",
            title: "Read current state",
            description: "Read-only lookup.",
            requiresApproval: false,
            risk: "LOW",
          },
          {
            order: 2,
            action: "DELETE",
            title: "Delete production record",
            description: "Destructive operation.",
            requiresApproval: false,
            risk: "LOW",
          },
          {
            order: 3,
            action: "DB_UPDATE",
            title: "Update production row",
            description: "Mutating database operation.",
            requiresApproval: false,
            risk: "LOW",
          },
        ],
        expectedOutputs: [],
        failureConditions: [],
        verificationRequirements: [],
      }),
    }),
  } as unknown as AIGateway;

  const engine = new ReasoningEngine(gateway);
  const request = engine.createRequest({
    goal: "Delete a production record after checking its state.",
    unresolvedQuestions: [],
  });
  const plan = await engine.createAIPlan(request);

  const read = plan.steps.find((step) => step.action === "GET");
  const deletion = plan.steps.find((step) => step.action === "DELETE");
  const update = plan.steps.find((step) => step.action === "DB_UPDATE");

  assert(read?.requiresApproval === false, "Read-only GET should not inherit destructive approval.");
  assert(deletion?.requiresApproval === true && deletion.risk === "HIGH", "Model LOW risk must not downgrade DELETE.");
  assert(update?.requiresApproval === true && update.risk === "HIGH", "Model LOW risk must not downgrade DB_UPDATE.");
  assert(plan.status === "WAITING_APPROVAL", "Any sensitive step must hold the complete plan for approval.");

  console.log("AI plan approval-risk regression test: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
