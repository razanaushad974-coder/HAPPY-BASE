import { PlanningEngine } from "../../../core/reasoning/planning-engine";
import type { ExecutionPlan, PlanStep } from "../../../core/reasoning/types";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

const planning = new PlanningEngine();

function step(overrides: Partial<PlanStep> = {}): PlanStep {
  return {
    id: "step-1",
    order: 1,
    action: "GET",
    title: "Read record",
    description: "Read-only operation",
    dependencies: [],
    requiresApproval: false,
    risk: "LOW",
    verificationRequired: true,
    ...overrides,
  };
}

function plan(overrides: Partial<ExecutionPlan> = {}): ExecutionPlan {
  return {
    id: "plan-1",
    reasoningRequestId: "reasoning-1",
    goal: "Test approval policy",
    status: "READY",
    risk: "LOW",
    resolvedReferences: [],
    assumptions: [],
    unresolvedQuestions: [],
    requiredCapabilities: [],
    steps: [step()],
    expectedOutputs: [],
    failureConditions: [],
    verificationRequirements: [],
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

const lowRiskRead = plan();
assert(planning.validate(lowRiskRead).valid, "Low-risk read plan should validate.");
assert(planning.getExecutableSteps(lowRiskRead).length === 1, "READY low-risk plan should be executable.");

for (const sensitiveAction of ["DELETE", "DB_UPDATE", "DB_DELETE", "DEPLOY", "PUBLISH", "CONTROL"] as const) {
  const forged = plan({ steps: [step({ action: sensitiveAction, risk: "LOW", requiresApproval: false })] });
  assert(!planning.validate(forged).valid, `${sensitiveAction} without approval passed validation.`);
  assert(planning.getExecutableSteps(forged).length === 0, `${sensitiveAction} without approval was executable.`);
}

for (const risk of ["MEDIUM", "HIGH", "CRITICAL"] as const) {
  const forged = plan({ steps: [step({ risk, requiresApproval: false })] });
  assert(!planning.validate(forged).valid, `${risk} step without approval passed validation.`);
  assert(planning.getExecutableSteps(forged).length === 0, `${risk} step without approval was executable.`);
}

for (const status of ["PLANNED", "WAITING_APPROVAL", "NEEDS_CLARIFICATION", "BLOCKED", "FAILED"] as const) {
  const notReady = plan({ status });
  assert(planning.getExecutableSteps(notReady).length === 0, `${status} plan was executable.`);
}

const approvedHighRisk = plan({
  risk: "HIGH",
  steps: [step({ action: "DELETE", risk: "HIGH", requiresApproval: true })],
});
assert(planning.validate(approvedHighRisk).valid, "Explicitly approval-gated high-risk plan should validate.");
assert(planning.getExecutableSteps(approvedHighRisk).length === 1, "READY plan with approval requirement should be returned only after external approval transition.");

console.log("Planning engine approval validation regression test: PASS");
