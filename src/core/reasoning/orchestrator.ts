import { PlanningEngine } from "./planning-engine";
import { ReasoningEngine } from "./engine";
import type { ExecutionPlan } from "./types";

export class ReasoningOrchestrator {
  private readonly reasoning = new ReasoningEngine();
  private readonly planning = new PlanningEngine();

  createExecutionPlan(input: {
    goal: string;
    contextSummary?: string;
    resolvedReferences?: import("../context/types").ResolvedReference[];
    constraints?: string[];
    knownFacts?: string[];
    assumptions?: string[];
    unresolvedQuestions?: string[];
    requiredCapabilities?: string[];
    requiredKnowledgeSources?: string[];
  }): ExecutionPlan {
    const request = this.reasoning.createRequest(input);
    const plan = this.reasoning.createPlan(request);

    const validation = this.planning.validate(plan);

    if (!validation.valid) {
      return {
        ...plan,
        status: "FAILED",
        failureConditions: [
          ...plan.failureConditions,
          ...validation.errors,
        ],
      };
    }

    return plan;
  }
}

