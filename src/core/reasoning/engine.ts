import { AIGateway } from "../ai/gateway";
import type { AIMessage } from "../ai/types";

import type {
  ExecutionPlan,
  PlanRisk,
  PlanStep,
  PlanStepAction,
  ReasoningRequest,
} from "./types";

function createId(prefix: string): string {
  return `${prefix}-${crypto.randomUUID()}`;
}

function asString(value: unknown): string {
  return typeof value === "string" ? value : "";
}

function asStringArray(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }

  return value.filter(
    (item): item is string =>
      typeof item === "string",
  );
}

function asBoolean(value: unknown): boolean {
  return value === true;
}

function isPlanStepAction(
  value: unknown,
): value is PlanStepAction {
  return [
    "UNDERSTAND",
    "RESEARCH",
    "CREATE",
    "MODIFY",
    "BUILD",
    "TEST",
    "VERIFY",
    "DEPLOY",
    "PUBLISH",
    "AUTOMATE",
    "CONTROL",
  ].includes(value as PlanStepAction);
}

function isPlanRisk(
  value: unknown,
): value is PlanRisk {
  return [
    "LOW",
    "MEDIUM",
    "HIGH",
    "CRITICAL",
  ].includes(value as PlanRisk);
}

function parseJsonObject(
  content: string,
): Record<string, unknown> {
  const trimmed = content.trim();

  try {
    return JSON.parse(trimmed) as Record<string, unknown>;
  } catch {
    const fenced = trimmed
      .replace(/^```json\s*/i, "")
      .replace(/^```\s*/i, "")
      .replace(/\s*```$/i, "")
      .trim();

    return JSON.parse(fenced) as Record<string, unknown>;
  }
}

export class ReasoningEngine {
  constructor(
    private readonly gateway: AIGateway =
      new AIGateway(),
  ) {}

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
      contextSummary:
        input.contextSummary?.trim() ?? "",
      resolvedReferences:
        input.resolvedReferences ?? [],
      constraints:
        input.constraints ?? [],
      knownFacts:
        input.knownFacts ?? [],
      assumptions:
        input.assumptions ?? [],
      unresolvedQuestions:
        input.unresolvedQuestions ?? [],
      requiredCapabilities:
        input.requiredCapabilities ?? [],
      requiredKnowledgeSources:
        input.requiredKnowledgeSources ?? [],
      createdAt:
        new Date().toISOString(),
    };
  }

  assessRisk(
    request: ReasoningRequest,
  ): PlanRisk {
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

    if (
      /database|api|automation|external|auth|user data/.test(
        text,
      )
    ) {
      return "MEDIUM";
    }

    return "LOW";
  }

  private createDeterministicFallback(
    request: ReasoningRequest,
    risk: PlanRisk,
  ): ExecutionPlan {
    const steps: PlanStep[] = [
      {
        id: createId("plan-step"),
        order: 1,
        action: "UNDERSTAND",
        title:
          "Understand the requested goal",
        description:
          "Resolve the user's goal, context, constraints, facts and unresolved references before execution.",
        dependencies: [],
        requiresApproval: false,
        risk: "LOW",
        verificationRequired: true,
      },
      {
        id: createId("plan-step"),
        order: 2,
        action: "RESEARCH",
        title:
          "Collect required knowledge",
        description:
          "Identify and use the knowledge required for the goal.",
        dependencies: [],
        requiresApproval: false,
        risk: "LOW",
        verificationRequired: true,
      },
      {
        id: createId("plan-step"),
        order: 3,
        action: "BUILD",
        title:
          "Execute the planned work",
        description:
          "Hand the approved implementation work to the appropriate capability.",
        targetReference:
          request.resolvedReferences[0],
        dependencies: [],
        requiresApproval:
          risk === "HIGH" ||
          risk === "CRITICAL",
        risk,
        verificationRequired: true,
      },
      {
        id: createId("plan-step"),
        order: 4,
        action: "TEST",
        title: "Test the result",
        description:
          "Run validation before completion.",
        dependencies: [],
        requiresApproval: false,
        risk: "MEDIUM",
        verificationRequired: true,
      },
      {
        id: createId("plan-step"),
        order: 5,
        action: "VERIFY",
        title: "Verify the outcome",
        description:
          "Verify the actual result and require evidence.",
        dependencies: [],
        requiresApproval: false,
        risk: "MEDIUM",
        verificationRequired: true,
      },
    ];

    return {
      id: createId("execution-plan"),
      reasoningRequestId: request.id,
      goal: request.goal,
      status:
        request.unresolvedQuestions.length > 0
          ? "NEEDS_CLARIFICATION"
          : risk === "HIGH" ||
              risk === "CRITICAL"
            ? "WAITING_APPROVAL"
            : "READY",
      risk,
      resolvedReferences:
        request.resolvedReferences,
      assumptions:
        request.assumptions,
      unresolvedQuestions:
        request.unresolvedQuestions,
      requiredCapabilities:
        request.requiredCapabilities,
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
      createdAt:
        new Date().toISOString(),
    };
  }

  private buildSystemPrompt(): string {
    return `
You are HAPPY's reasoning planner.

You do NOT execute actions.
You do NOT claim success.
You do NOT bypass approval.
You only create a structured execution plan.

Return ONLY valid JSON.

Required JSON:
{
  "steps": [
    {
      "order": 1,
      "action": "UNDERSTAND",
      "title": "string",
      "description": "string",
      "requiresApproval": false,
      "risk": "LOW",
      "verificationRequired": true
    }
  ],
  "expectedOutputs": ["string"],
  "failureConditions": ["string"],
  "verificationRequirements": ["string"]
}

Allowed actions:
UNDERSTAND, RESEARCH, CREATE, MODIFY, BUILD, TEST,
VERIFY, DEPLOY, PUBLISH, AUTOMATE, CONTROL

Allowed risks:
LOW, MEDIUM, HIGH, CRITICAL

Rules:
- Every step must require verification.
- HIGH or CRITICAL actions require approval.
- Never invent execution evidence.
- Do not claim a task was executed.
`;
  }

  private buildMessages(
    request: ReasoningRequest,
  ): AIMessage[] {
    return [
      {
        role: "system",
        content:
          this.buildSystemPrompt(),
      },
      {
        role: "user",
        content: JSON.stringify({
          goal: request.goal,
          contextSummary:
            request.contextSummary,
          resolvedReferences:
            request.resolvedReferences,
          constraints:
            request.constraints,
          knownFacts:
            request.knownFacts,
          assumptions:
            request.assumptions,
          unresolvedQuestions:
            request.unresolvedQuestions,
          requiredCapabilities:
            request.requiredCapabilities,
          requiredKnowledgeSources:
            request.requiredKnowledgeSources,
        }),
      },
    ];
  }

  private parseAIPlan(
    request: ReasoningRequest,
    content: string,
  ): ExecutionPlan {
    const raw =
      parseJsonObject(content);

    const rawSteps =
      Array.isArray(raw.steps)
        ? raw.steps
        : [];

    if (rawSteps.length === 0) {
      throw new Error(
        "Gemini returned no plan steps.",
      );
    }

    const assessedRisk =
      this.assessRisk(request);

    const steps: PlanStep[] =
      rawSteps.map(
        (
          item: unknown,
          index: number,
        ) => {
          if (
            typeof item !== "object" ||
            item === null
          ) {
            throw new Error(
              `Invalid plan step ${index + 1}.`,
            );
          }

          const step =
            item as Record<string, unknown>;

          if (
            !isPlanStepAction(
              step.action,
            )
          ) {
            throw new Error(
              `Invalid plan action at step ${index + 1}.`,
            );
          }

          const declaredRisk =
            isPlanRisk(step.risk)
              ? step.risk
              : "LOW";

          const requiresApproval =
            asBoolean(
              step.requiresApproval,
            ) ||
            declaredRisk === "HIGH" ||
            declaredRisk === "CRITICAL";

          return {
            id: createId("plan-step"),
            order:
              typeof step.order ===
              "number"
                ? step.order
                : index + 1,
            action: step.action,
            title:
              asString(step.title) ||
              `${step.action} step`,
            description:
              asString(
                step.description,
              ),
            targetReference:
              step.action === "BUILD"
                ? request.resolvedReferences[0]
                : undefined,
            dependencies: [],
            requiresApproval,
            risk:
              declaredRisk === "LOW" &&
              (assessedRisk === "HIGH" ||
                assessedRisk === "CRITICAL") &&
              step.action === "BUILD"
                ? assessedRisk
                : declaredRisk,
            verificationRequired: true,
          };
        },
      );

    const approvalRequired =
      steps.some(
        (step) =>
          step.requiresApproval,
      );

    return {
      id: createId("execution-plan"),
      reasoningRequestId: request.id,
      goal: request.goal,
      status:
        request.unresolvedQuestions.length > 0
          ? "NEEDS_CLARIFICATION"
          : approvalRequired
            ? "WAITING_APPROVAL"
            : "READY",
      risk: assessedRisk,
      resolvedReferences:
        request.resolvedReferences,
      assumptions:
        request.assumptions,
      unresolvedQuestions:
        request.unresolvedQuestions,
      requiredCapabilities:
        request.requiredCapabilities,
      steps,
      expectedOutputs:
        asStringArray(
          raw.expectedOutputs,
        ),
      failureConditions:
        asStringArray(
          raw.failureConditions,
        ),
      verificationRequirements:
        asStringArray(
          raw.verificationRequirements,
        ),
      createdAt:
        new Date().toISOString(),
    };
  }

  async createAIPlan(
    request: ReasoningRequest,
  ): Promise<ExecutionPlan> {
    const risk =
      this.assessRisk(request);

    if (
      request.unresolvedQuestions.length > 0
    ) {
      return this.createDeterministicFallback(
        request,
        risk,
      );
    }

    const response =
      await this.gateway.complete({
        provider: "GEMINI",
        mode: "PLAN",
        messages:
          this.buildMessages(request),
        temperature: 0.2,
        maxTokens: 3000,
      });

    if (
      !response.success ||
      response.status !== "COMPLETED" ||
      !response.content
    ) {
      return this.createDeterministicFallback(
        request,
        risk,
      );
    }

    try {
      return this.parseAIPlan(
        request,
        response.content,
      );
    } catch {
      return this.createDeterministicFallback(
        request,
        risk,
      );
    }
  }

  /*
   * Existing synchronous contract preserved
   * for Step 32 and deterministic callers.
   */
  createPlan(
    request: ReasoningRequest,
  ): ExecutionPlan {
    return this.createDeterministicFallback(
      request,
      this.assessRisk(request),
    );
  }
}
