import type {
  BuildPlan,
  BuildRequest,
  BuildRisk,
  BuildStatus,
} from "./types";

function calculateRisk(
  requirements: string[],
): BuildRisk {
  const text = requirements
    .join(" ")
    .toLowerCase();

  if (
    text.includes("security") ||
    text.includes("authentication") ||
    text.includes("payment") ||
    text.includes("database")
  ) {
    return "HIGH";
  }

  if (
    text.includes("api") ||
    text.includes("deployment") ||
    text.includes("publish")
  ) {
    return "MEDIUM";
  }

  return "LOW";
}

export class BuildPlanEngine {
  createPlan(
    request: BuildRequest,
  ): BuildPlan {
    const risk =
      calculateRisk(request.requirements);

    const requiresApproval =
      risk === "HIGH" ||
      request.requirements.some(
        (item) =>
          /deploy|publish|delete|payment/i.test(
            item,
          ),
      );

    const plan: BuildPlan = {
      id: `buildplan_${crypto.randomUUID()}`,
      commandId: request.commandId,
      title:
        request.objective ||
        "HAPPY build task",
      objective: request.objective,
      requirements: [
        ...request.requirements,
      ],
      constraints: [
        ...request.constraints,
      ],
      fileChanges: [],
      tests: [],
      risk,
      status: requiresApproval
        ? "WAITING_APPROVAL"
        : "PLANNED",
      requiresApproval,
      createdAt:
        new Date().toISOString(),
    };

    return plan;
  }

  updateStatus(
    plan: BuildPlan,
    status: BuildStatus,
  ): BuildPlan {
    return {
      ...plan,
      status,
    };
  }
}
