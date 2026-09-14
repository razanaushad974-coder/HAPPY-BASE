import { FounderCommandEngine } from "@/core/founder/command-engine";
import { BuildPlanEngine } from "@/core/build/plan-engine";
import { BuildTestPlanner } from "@/core/build/test-planner";
import { ChangeSetEngine } from "@/core/build/change-set";
import { SelfBuildOrchestrator } from "@/core/build/orchestrator";
import { WorkspaceChangeStager } from "@/core/build/workspace/stager";

function main(): void {
  const founder =
    new FounderCommandEngine();

  const command =
    founder.create(
      "HAPPY, Founder Dashboard ka API system build karo",
    );

  if (command.mode !== "BUILD") {
    throw new Error(
      "Founder command was not classified as BUILD.",
    );
  }

  const request = {
    id: `buildreq_${crypto.randomUUID()}`,
    commandId: command.id,
    objective:
      "Build Founder Dashboard API system",
    requirements: [
      "Founder Dashboard is required.",
      "API integration is required.",
      "Database storage is required.",
      "Security authentication is required.",
    ],
    constraints: [
      "Do not delete existing functionality.",
      "Use controlled file changes.",
      "Do not execute unapproved commands.",
    ],
    referencedFiles: [
      "src/core/founder/command-engine.ts",
    ],
    createdAt:
      new Date().toISOString(),
  };

  const orchestrator =
    new SelfBuildOrchestrator();

  const plan =
    orchestrator.createBuildPlan(
      request,
    );

  if (
    plan.status !==
    "WAITING_APPROVAL"
  ) {
    throw new Error(
      `Expected approval gate, got ${plan.status}.`,
    );
  }

  if (!plan.requiresApproval) {
    throw new Error(
      "High-risk build did not require approval.",
    );
  }

  if (
    plan.tests.length < 3
  ) {
    throw new Error(
      "Default test plan was not attached.",
    );
  }

  const changeSet =
    new ChangeSetEngine();

  if (
    !changeSet.validatePath(
      "src/core/test.ts",
    )
  ) {
    throw new Error(
      "Valid workspace path was rejected.",
    );
  }

  if (
    changeSet.validatePath(
      "../outside-project.ts",
    )
  ) {
    throw new Error(
      "Unsafe traversal path was accepted.",
    );
  }

  const staged =
    new WorkspaceChangeStager();

  const firstChange =
    plan.fileChanges[0];

  if (!firstChange) {
    throw new Error(
      "Expected referenced file change.",
    );
  }

  const stagedChange =
    staged.stage(firstChange);

  if (
    stagedChange.changeId !==
    firstChange.id
  ) {
    throw new Error(
      "Change staging failed.",
    );
  }

  console.log(
    "Self-build foundation test: PASS",
  );

  console.log({
    commandMode: command.mode,
    planStatus: plan.status,
    approvalRequired:
      plan.requiresApproval,
    risk: plan.risk,
    fileChanges:
      plan.fileChanges.length,
    tests:
      plan.tests.length,
    safePathAccepted:
      changeSet.validatePath(
        "src/core/test.ts",
      ),
    traversalBlocked:
      !changeSet.validatePath(
        "../outside-project.ts",
      ),
    stagedChange:
      stagedChange.changeId ===
      firstChange.id,
  });

  console.log(
    "Actual shell execution: NOT_YET_CONNECTED",
  );
  console.log(
    "Sandbox execution: NOT_YET_CONNECTED",
  );
  console.log(
    "AI code generation provider: NOT_YET_CONNECTED",
  );
  console.log(
    "Git commit automation: NOT_YET_CONNECTED",
  );
  console.log(
    "Deployment automation: NOT_YET_CONNECTED",
  );
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
