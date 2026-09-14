import {
  SandboxRunner,
} from "@/core/sandbox/runner";

function main(): void {
  const runner =
    new SandboxRunner();

  const passJob =
    runner.createJob(
      "plan_test",
      "PASS",
    );

  const pass =
    runner.run(passJob);

  if (
    pass.status !== "PASSED" ||
    pass.exitCode !== 0
  ) {
    throw new Error(
      "Bounded sandbox PASS case failed.",
    );
  }

  const failJob =
    runner.createJob(
      "plan_test",
      "FAIL",
    );

  const failed =
    runner.run(failJob);

  if (
    failed.status !== "FAILED" ||
    failed.exitCode !== 1
  ) {
    throw new Error(
      "Bounded sandbox FAIL case failed.",
    );
  }

  const blockedJob =
    runner.createJob(
      "plan_test",
      "powershell.exe rm -rf /",
    );

  const blocked =
    runner.run(blockedJob);

  if (
    blocked.status !== "BLOCKED"
  ) {
    throw new Error(
      "Unsafe command was not blocked.",
    );
  }

  console.log(
    "Sandbox runtime test: PASS",
  );

  console.log({
    passStatus: pass.status,
    failStatus: failed.status,
    unsafeCommandBlocked:
      blocked.status === "BLOCKED",
    networkAccess:
      passJob.limits.networkAccess,
  });
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
