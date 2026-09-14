import type {
  ExecutionPlan,
  PlanRisk,
  PlanStep,
  ReasoningRequest,
} from "./types";

export class ReasoningEngine {
  createRequest(input: {
    goal: string;
    contextSummary?: string;
    resolvedReferences?: import("../context/types").ResolvedReference[];
    constraints?: string[];
    knownFacts?: string[];
    assumptions?: string[];
    unresolvedQuestions?: string[];
    requiredCapabilities?: string[];
    requiredKnowledgeSources?: string[];
  }): ReasoningRequest {
    const goal = input.goal.trim();

    if (!goal) {
      throw new Error("Reasoning goal is required.");
    }

    return {
      id: crypto.randomUUID(),
      mode: "REASON",
      goal,
      contextSummary: input.contextSummary?.trim() ?? "",
      resolvedReferences: input.resolvedReferences ?? [],
      constraints: input.constraints ?? [],
      knownFacts: input.knownFacts ?? [],
      assumptions: input.assumptions ?? [],
      unresolvedQuestions: input.unresolvedQuestions ?? [],
      requiredCapabilities: input.requiredCapabilities ?? [],
      requiredKnowledgeSources: input.requiredKnowledgeSources ?? [],
      createdAt: new Date().toISOString(),
    };
  }

  assessRisk(request: ReasoningRequest): PlanRisk {
    const text = [
      request.goal,
      ...request.constraints,
      ...request.requiredCapabilities,
    ]
      .join(" ")
      .toLowerCase();

    if (
      /payment|delete|security|credential|production|deploy|publish|admin/.test(
        text,
      )
    ) {
      return "HIGH";
    }

    if (/database|api|automation|external|auth|user data/.test(text)) {
      return "MEDIUM";
    }

    return "LOW";
  }

  createPlan(request: ReasoningRequest): ExecutionPlan {
    const risk = this.assessRisk(request);

    const steps: PlanStep[] = [
      {
        id: crypto.randomUUID(),
        order: 1,
        action: "UNDERSTAND",
        title: "Understand the requested goal",
        description:
          "Resolve the user's goal, context, constraints, facts and unresolved references before execution.",
        dependencies: [],
        requiresApproval: false,
        risk: "LOW",
        verificationRequired: true,
      },
      {
        id: crypto.randomUUID(),
        order: 2,
        action: "RESEARCH",
        title: "Collect required knowledge",
        description:
          "Identify and use the knowledge sources and information required for the goal.",
        dependencies: [],
        requiresApproval: false,
        risk: "LOW",
        verificationRequired: true,
      },
      {
        id: crypto.randomUUID(),
        order: 3,
        action: "BUILD",
        title: "Execute the planned work",
        description:
          "Hand the approved implementation work to the appropriate capability or build system.",
        targetReference:
          request.resolvedReferences[0],
        dependencies: [],
        requiresApproval: risk === "HIGH" || risk === "CRITICAL",
        risk,
        verificationRequired: true,
      },
      {
        id: crypto.randomUUID(),
        order: 4,
        action: "TEST",
        title: "Test the result",
        description:
          "Run the required validation and test plan before declaring completion.",
        dependencies: [],
        requiresApproval: false,
        risk: "MEDIUM",
        verificationRequired: true,
      },
      {
        id: crypto.randomUUID(),
        order: 5,
        action: "VERIFY",
        title: "Verify the outcome",
        description:
          "Verify the actual result and require evidence before completion.",
        dependencies: [],
        requiresApproval: false,
        risk: "MEDIUM",
        verificationRequired: true,
      },
    ];

    if (request.unresolvedQuestions.length > 0) {
      return {
        id: crypto.randomUUID(),
        reasoningRequestId: request.id,
        goal: request.goal,
        status: "NEEDS_CLARIFICATION",
        risk,
        resolvedReferences: request.resolvedReferences,
        assumptions: request.assumptions,
        unresolvedQuestions: request.unresolvedQuestions,
        requiredCapabilities: request.requiredCapabilities,
        steps,
        expectedOutputs: ["Clarified requirements", "Executable plan"],
        failureConditions: [
          "Required information remains unresolved.",
          "A required capability is unavailable.",
        ],
        verificationRequirements: [
          "All required questions are resolved.",
          "Plan is internally consistent.",
        ],
        createdAt: new Date().toISOString(),
      };
    }

    const approvalRequired = steps.some((step) => step.requiresApproval);

    return {
      id: crypto.randomUUID(),
      reasoningRequestId: request.id,
      goal: request.goal,
      status: approvalRequired ? "WAITING_APPROVAL" : "READY",
      risk,
      resolvedReferences: request.resolvedReferences,
      assumptions: request.assumptions,
      unresolvedQuestions: [],
      requiredCapabilities: request.requiredCapabilities,
      steps,
      expectedOutputs: [
        "Completed requested work",
        "Test results",
        "Verification evidence",
      ],
      failureConditions: [
        "Required capability unavailable.",
        "Validation fails.",
        "Verification evidence is insufficient.",
      ],
      verificationRequirements: [
        "All required tests pass.",
        "Actual output matches the requested goal.",
        "Evidence is recorded before completion.",
      ],
      createdAt: new Date().toISOString(),
    };
  }
}



