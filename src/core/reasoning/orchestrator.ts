import { PlanningEngine } from "./planning-engine";
import { ReasoningEngine } from "./engine";
import type { ExecutionPlan } from "./types";

export class ReasoningOrchestrator {
  private readonly reasoning =
    new ReasoningEngine();

  private readonly planning =
    new PlanningEngine();

  /*
   * EXISTING SYNCHRONOUS CONTRACT
   *
   * Preserved for existing tests and deterministic callers.
   */
  createExecutionPlan(
    input: {
      goal: string;
      contextSummary?: string;
      resolvedReferences?: import("../context/types").ResolvedReference[];
      constraints?: string[];
      knownFacts?: string[];
      assumptions?: string[];
      unresolvedQuestions?: string[];
      requiredCapabilities?: string[];
      requiredKnowledgeSources?: string[];
    },
  ): ExecutionPlan {
    const request =
      this.reasoning.createRequest(input);

    const plan =
      this.reasoning.createPlan(request);

    const validation =
      this.planning.validate(plan);

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

  /*
   * NEW ASYNCHRONOUS AI CONTRACT
   *
   * Uses Gemini through the single HAPPY AI gateway.
   */
  async createAIExecutionPlan(
    input: {
      goal: string;
      contextSummary?: string;
      resolvedReferences?: import("../context/types").ResolvedReference[];
      constraints?: string[];
      knownFacts?: string[];
      assumptions?: string[];
      unresolvedQuestions?: string[];
      requiredCapabilities?: string[];
      requiredKnowledgeSources?: string[];
    },
  ): Promise<ExecutionPlan> {
    const request =
      this.reasoning.createRequest(input);

    const plan =
      await this.reasoning.createAIPlan(request);

    const validation =
      this.planning.validate(plan);

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
