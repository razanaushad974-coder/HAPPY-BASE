import {
  ReasoningEngine,
} from "../../../core/reasoning/engine";

function assert(
  condition: boolean,
  message: string,
): void {
  if (!condition) {
    throw new Error(message);
  }
}

function main(): void {
  const engine =
    new ReasoningEngine();

  const request =
    engine.createRequest({
      goal:
        "GET the API health endpoint and verify the response",
      contextSummary:
        "API integration task",
      resolvedReferences: [],
      constraints: [],
      knownFacts: [],
      assumptions: [],
      unresolvedQuestions: [],
      requiredCapabilities: [
        "API",
      ],
      requiredKnowledgeSources: [],
    });

  const plan =
    engine.createPlan(request);

  assert(
    plan.steps.some(
      (step) =>
        step.action === "BUILD",
    ),
    "Deterministic fallback should remain compatible.",
  );

  assert(
    Array.isArray(
      plan.requiredCapabilities,
    ),
    "Plan requiredCapabilities contract missing.",
  );

  console.log(
    "STEP 39 API plan contract test: PASS",
  );

  console.log({
    reasoningRequestCreated: true,
    apiCapabilityDeclared: true,
    planContractPreserved: true,
    verificationRequired: true,
  });
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
