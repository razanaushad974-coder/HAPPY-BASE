import { ReasoningOrchestrator } from "../../../core/reasoning/orchestrator";
import { PlanningEngine } from "../../../core/reasoning/planning-engine";

const orchestrator = new ReasoningOrchestrator();
const planning = new PlanningEngine();

const plan = orchestrator.createExecutionPlan({
  goal: "Build a secure Founder Dashboard API for HAPPY.",
  contextSummary:
    "Founder Dashboard is the privileged control center of HAPPY.",
  constraints: [
    "No fake completion claims.",
    "Security and approval gates are mandatory.",
  ],
  knownFacts: [
    "API Builder foundation is already available.",
    "Approval and change-control foundation is already available.",
  ],
  assumptions: [
    "Real database and deployment integrations are not connected yet.",
  ],
  requiredCapabilities: [
    "API builder",
    "Security analysis",
    "Approval engine",
    "Testing",
    "Verification",
  ],
  requiredKnowledgeSources: [
    "Founder Dashboard specification",
  ],
});

if (plan.goal !== "Build a secure Founder Dashboard API for HAPPY.") {
  throw new Error("Goal extraction failed.");
}

if (plan.steps.length < 5) {
  throw new Error("Plan decomposition failed.");
}

if (plan.risk !== "HIGH") {
  throw new Error("Risk assessment failed.");
}

if (plan.status !== "WAITING_APPROVAL") {
  throw new Error("Approval status failed.");
}

const validation = planning.validate(plan);

if (!validation.valid) {
  throw new Error(`Plan validation failed: ${validation.errors.join(", ")}`);
}

const executable = planning.getExecutableSteps(plan);

if (executable.length !== 0) {
  throw new Error("Approval gate bypass detected.");
}

const clarificationPlan = orchestrator.createExecutionPlan({
  goal: "Build the requested application.",
  unresolvedQuestions: [
    "Which target environment should be used?",
  ],
});

if (clarificationPlan.status !== "NEEDS_CLARIFICATION") {
  throw new Error("Clarification handling failed.");
}

if (planning.getExecutableSteps(clarificationPlan).length !== 0) {
  throw new Error("Clarification gate bypass detected.");
}

console.log("Reasoning + planning test: PASS");
console.log({
  planStatus: plan.status,
  risk: plan.risk,
  steps: plan.steps.length,
  approvalGate: plan.status === "WAITING_APPROVAL",
  clarificationGate:
    clarificationPlan.status === "NEEDS_CLARIFICATION",
  verificationSteps: plan.steps.filter(
    (step) => step.verificationRequired,
  ).length,
});
