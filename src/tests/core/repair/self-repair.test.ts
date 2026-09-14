import {
  SelfRepairOrchestrator,
} from "@/core/repair/orchestrator";
import type {
  BuildPlan,
} from "@/core/build/types";

function main(): void {
  const plan: BuildPlan = {
    id: "buildplan_repair_test",
    commandId: "command_repair_test",
    title:
      "Self repair test",
    objective:
      "Verify failure analysis and repair planning.",
    requirements: [
      "TypeScript compilation is required.",
    ],
    constraints: [
      "Do not apply unapproved changes.",
    ],
    fileChanges: [],
    tests: [
      {
        id: "test_repair",
        type: "TYPECHECK",
        command:
          "npx tsc --noEmit",
        description:
          "TypeScript validation.",
        required: true,
      },
    ],
    risk: "HIGH",
    status: "PLANNED",
    requiresApproval: true,
    createdAt:
      new Date().toISOString(),
  };

  const orchestrator =
    new SelfRepairOrchestrator();

  const result =
    orchestrator.runTest(plan);

  if (
    !result.testPassed ||
    result.nextAction !==
      "COMPLETED"
  ) {
    throw new Error(
      "Successful test cycle failed.",
    );
  }

  const failingPlan: BuildPlan = {
    ...plan,
    tests: [
      {
        ...plan.tests[0],
        command: "FAIL",
      },
    ],
  };

  const failureResult =
    orchestrator.runTest(
      failingPlan,
    );

  if (
    failureResult.testPassed
  ) {
    throw new Error(
      "Failure case incorrectly passed.",
    );
  }

  if (
    !failureResult.failureId
  ) {
    throw new Error(
      "Failure report was not created.",
    );
  }

  if (
    !failureResult.repairPlan
  ) {
    throw new Error(
      "Repair plan was not created.",
    );
  }

  if (
    failureResult.repairPlan.status !==
    "PROPOSED"
  ) {
    throw new Error(
      "Expected bounded repair proposal.",
    );
  }

  console.log(
    "Self-repair runtime test: PASS",
  );

  console.log({
    successfulCycle:
      result.nextAction,
    failureDetected:
      Boolean(
        failureResult.failureId,
      ),
    repairPlanCreated:
      Boolean(
        failureResult.repairPlan,
      ),
    repairStatus:
      failureResult.repairPlan.status,
    noAutomaticRepairApplied:
      failureResult.repairPlan.actions
        .length === 0,
  });
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
