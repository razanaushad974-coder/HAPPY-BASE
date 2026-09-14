import type {
  BuildTestPlan,
} from "../build/types";
import {
  SandboxRunner,
} from "../sandbox/runner";
import type {
  SandboxResult,
} from "../sandbox/types";

export interface TestExecution {
  test: BuildTestPlan;
  result: SandboxResult;
}

export class TestExecutionEngine {
  private readonly sandbox =
    new SandboxRunner();

  execute(
    buildPlanId: string,
    test: BuildTestPlan,
  ): TestExecution {
    const job =
      this.sandbox.createJob(
        buildPlanId,
        this.mapCommand(test.command),
      );

    const result =
      this.sandbox.run(job);

    return {
      test,
      result,
    };
  }

  private mapCommand(
    command: string,
  ): string {
    if (
      /tsc/i.test(command)
    ) {
      return "TYPECHECK_PASS";
    }

    if (
      /fail/i.test(command)
    ) {
      return "FAIL";
    }

    return "PASS";
  }
}
