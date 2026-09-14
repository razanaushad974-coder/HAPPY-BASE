import type {
  FailureReport,
  RepairPlan,
} from "./types";

export class RepairPlanner {
  createPlan(
    failure: FailureReport,
  ): RepairPlan {
    const diagnosis =
      this.diagnose(failure);

    const requiresApproval =
      failure.category ===
        "SECURITY_FAILURE" ||
      failure.category ===
        "UNKNOWN";

    return {
      id: `repair_${crypto.randomUUID()}`,
      buildPlanId:
        failure.buildPlanId,
      failureId: failure.id,
      diagnosis,
      actions: [],
      status: requiresApproval
        ? "WAITING_APPROVAL"
        : "PROPOSED",
      requiresApproval,
      createdAt:
        new Date().toISOString(),
    };
  }

  private diagnose(
    failure: FailureReport,
  ): string {
    switch (
      failure.category
    ) {
      case "TYPE_ERROR":
        return "Inspect TypeScript types/imports and prepare a bounded type correction.";

      case "TEST_FAILURE":
        return "Inspect the failing test and related implementation before proposing a minimal repair.";

      case "BUILD_FAILURE":
        return "Inspect production build diagnostics and dependency/configuration boundaries.";

      case "SECURITY_FAILURE":
        return "Security-related failure requires explicit approval before any repair action.";

      case "TIMEOUT":
        return "Inspect execution limits and identify the slow or blocking operation.";

      default:
        return "Failure requires additional evidence before a safe repair can be proposed.";
    }
  }
}
