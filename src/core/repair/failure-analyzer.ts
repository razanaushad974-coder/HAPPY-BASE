import type {
  FailureCategory,
  FailureReport,
} from "./types";

export class FailureAnalyzer {
  analyze(
    buildPlanId: string,
    stderr: string,
    exitCode: number | null,
    testId?: string,
  ): FailureReport {
    const message =
      stderr ||
      "Unknown execution failure.";

    let category: FailureCategory =
      "UNKNOWN";

    if (
      /typescript|tsc|type/i.test(
        message,
      )
    ) {
      category = "TYPE_ERROR";
    } else if (
      /security|permission|unauthorized/i.test(
        message,
      )
    ) {
      category = "SECURITY_FAILURE";
    } else if (
      /timeout|timed out/i.test(
        message,
      )
    ) {
      category = "TIMEOUT";
    } else if (
      /build|compilation/i.test(
        message,
      )
    ) {
      category = "BUILD_FAILURE";
    } else if (
      /test|failure|failed/i.test(
        message,
      )
    ) {
      category = "TEST_FAILURE";
    }

    return {
      id: `failure_${crypto.randomUUID()}`,
      buildPlanId,
      testId,
      category,
      message,
      stderr: message,
      exitCode,
      detectedAt:
        new Date().toISOString(),
    };
  }
}
