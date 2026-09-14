import type {
  BuildPlan,
} from "../build/types";
import {
  TestExecutionEngine,
} from "../sandbox/test-executor";
import {
  FailureAnalyzer,
} from "./failure-analyzer";
import {
  RepairPlanner,
} from "./repair-planner";
import type {
  RepairPlan,
} from "./types";

export interface RepairCycleResult {
  testPassed: boolean;
  failureId?: string;
  repairPlan?: RepairPlan;
  nextAction:
    | "COMPLETED"
    | "ANALYZE_FAILURE"
    | "WAITING_APPROVAL";
}

export class SelfRepairOrchestrator {
  private readonly tests =
    new TestExecutionEngine();

  private readonly analyzer =
    new FailureAnalyzer();

  private readonly planner =
    new RepairPlanner();

  runTest(
    plan: BuildPlan,
  ): RepairCycleResult {
    const test = plan.tests[0];

    if (!test) {
      return {
        testPassed: false,
        nextAction:
          "ANALYZE_FAILURE",
      };
    }

    const execution =
      this.tests.execute(
        plan.id,
        test,
      );

    if (
      execution.result.status ===
      "PASSED"
    ) {
      return {
        testPassed: true,
        nextAction: "COMPLETED",
      };
    }

    const failure =
      this.analyzer.analyze(
        plan.id,
        execution.result.stderr,
        execution.result.exitCode,
        test.id,
      );

    const repair =
      this.planner.createPlan(
        failure,
      );

    return {
      testPassed: false,
      failureId: failure.id,
      repairPlan: repair,
      nextAction:
        repair.requiresApproval
          ? "WAITING_APPROVAL"
          : "ANALYZE_FAILURE",
    };
  }
}
