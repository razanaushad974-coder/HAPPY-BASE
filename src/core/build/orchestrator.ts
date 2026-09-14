import type {
  BuildPlan,
  BuildRequest,
} from "./types";
import { BuildPlanEngine } from "./plan-engine";
import { ChangeSetEngine } from "./change-set";
import { BuildTestPlanner } from "./test-planner";

export class SelfBuildOrchestrator {
  private readonly planEngine =
    new BuildPlanEngine();

  private readonly changeSet =
    new ChangeSetEngine();

  private readonly testPlanner =
    new BuildTestPlanner();

  createBuildPlan(
    request: BuildRequest,
  ): BuildPlan {
    let plan =
      this.planEngine.createPlan(
        request,
      );

    plan =
      this.testPlanner.attachDefaultTests(
        plan,
      );

    for (
      const file of request.referencedFiles
    ) {
      if (
        this.changeSet.validatePath(
          file,
        )
      ) {
        plan =
          this.changeSet.addChange(
            plan,
            {
              action: "MODIFY",
              path: file,
              description:
                "Referenced workspace file requires inspection before modification.",
              risk: plan.risk,
              requiresApproval:
                plan.requiresApproval,
            },
          );
      }
    }

    return plan;
  }
}
