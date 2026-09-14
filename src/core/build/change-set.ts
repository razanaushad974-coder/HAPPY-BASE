import type {
  BuildFileChange,
  BuildPlan,
  BuildRisk,
} from "./types";

export class ChangeSetEngine {
  addChange(
    plan: BuildPlan,
    change: Omit<
      BuildFileChange,
      "id"
    >,
  ): BuildPlan {
    const nextChange: BuildFileChange = {
      ...change,
      id: `change_${crypto.randomUUID()}`,
    };

    return {
      ...plan,
      fileChanges: [
        ...plan.fileChanges,
        nextChange,
      ],
    };
  }

  validatePath(
    path: string,
  ): boolean {
    if (!path) {
      return false;
    }

    if (
      path.startsWith("/") ||
      path.includes("\\") ||
      path.includes("..")
    ) {
      return false;
    }

    return true;
  }

  requiresApproval(
    risk: BuildRisk,
  ): boolean {
    return (
      risk === "HIGH" ||
      risk === "CRITICAL"
    );
  }
}
