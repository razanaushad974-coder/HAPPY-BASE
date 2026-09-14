import type { ExecutionPlan, PlanStep } from "./types";

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
    if (plan.status === "NEEDS_CLARIFICATION") {
      return [];
    }

    if (plan.status === "WAITING_APPROVAL") {
      return [];
    }

    return [...plan.steps].sort((a, b) => a.order - b.order);
  }
}
