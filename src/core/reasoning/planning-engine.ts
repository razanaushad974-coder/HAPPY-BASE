import type { ExecutionPlan, PlanStep } from "./types";

const APPROVAL_REQUIRED_ACTIONS = new Set([
  "POST", "PUT", "PATCH", "DELETE", "DEPLOY", "PUBLISH", "CONTROL",
  "DB_INSERT", "DB_UPDATE", "DB_DELETE", "DB_TRANSACTION",
]);

function stepRequiresApproval(step: PlanStep): boolean {
  return step.risk !== "LOW" || APPROVAL_REQUIRED_ACTIONS.has(step.action);
}

export class PlanningEngine {
  validate(plan: ExecutionPlan): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];

    if (!plan.goal.trim()) {
      errors.push("Plan goal is empty.");
    }

    if (plan.steps.length === 0) {
      errors.push("Plan has no steps.");
    }

    const orders = plan.steps.map((step) => step.order);
    const uniqueOrders = new Set(orders);

    if (uniqueOrders.size !== orders.length) {
      errors.push("Plan step order contains duplicates.");
    }

    for (const step of plan.steps) {
      if (!step.title.trim()) {
        errors.push(`Step ${step.id} has no title.`);
      }

      if (stepRequiresApproval(step) && !step.requiresApproval) {
        errors.push(
          `Step ${step.id} (${step.action}/${step.risk}) must require approval.`,
        );
      }

      if (step.verificationRequired === false && step.action === "VERIFY") {
        errors.push(`Verification step ${step.id} must require verification.`);
      }
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  getExecutableSteps(plan: ExecutionPlan): PlanStep[] {
    // Only a validated READY plan is executable. Do not infer readiness from
    // the absence of NEEDS_CLARIFICATION/WAITING_APPROVAL.
    if (plan.status !== "READY") {
      return [];
    }

    const validation = this.validate(plan);
    if (!validation.valid) {
      return [];
    }

    return [...plan.steps].sort((a, b) => a.order - b.order);
  }
}
