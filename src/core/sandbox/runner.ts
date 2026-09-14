import type {
  SandboxJob,
  SandboxLimits,
  SandboxResult,
} from "./types";

const DEFAULT_LIMITS: SandboxLimits = {
  timeoutMs: 10_000,
  maxOutputBytes: 32_000,
  maxFiles: 100,
  networkAccess: false,
};

const ALLOWED_IN_PROCESS_COMMANDS = new Set([
  "PASS",
  "FAIL",
  "TYPECHECK_PASS",
  "TYPECHECK_FAIL",
]);

export class SandboxRunner {
  createJob(
    buildPlanId: string,
    command: string,
    limits: Partial<SandboxLimits> = {},
  ): SandboxJob {
    return {
      id: `sandbox_${crypto.randomUUID()}`,
      buildPlanId,
      command,
      provider: "IN_PROCESS",
      status: "QUEUED",
      limits: {
        ...DEFAULT_LIMITS,
        ...limits,
      },
      createdAt:
        new Date().toISOString(),
    };
  }

  run(
    job: SandboxJob,
  ): SandboxResult {
    const started = Date.now();

    if (
      !ALLOWED_IN_PROCESS_COMMANDS.has(
        job.command,
      )
    ) {
      return {
        jobId: job.id,
        status: "BLOCKED",
        exitCode: null,
        stdout: "",
        stderr:
          "Command is not allowed in the bounded in-process sandbox.",
        durationMs:
          Date.now() - started,
        timedOut: false,
        provider: "IN_PROCESS",
      };
    }

    if (
      job.command === "FAIL" ||
      job.command === "TYPECHECK_FAIL"
    ) {
      return {
        jobId: job.id,
        status: "FAILED",
        exitCode: 1,
        stdout: "",
        stderr:
          job.command === "TYPECHECK_FAIL"
            ? "TypeScript compilation failed."
            : "Simulated test failure.",
        durationMs:
          Date.now() - started,
        timedOut: false,
        provider: "IN_PROCESS",
      };
    }

    return {
      jobId: job.id,
      status: "PASSED",
      exitCode: 0,
      stdout:
        "Bounded sandbox test passed.",
      stderr: "",
      durationMs:
        Date.now() - started,
      timedOut: false,
      provider: "IN_PROCESS",
    };
  }
}
