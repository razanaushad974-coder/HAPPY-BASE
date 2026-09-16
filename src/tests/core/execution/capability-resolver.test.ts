import { resolveExecutionCapability } from "../../../core/execution/capability-resolver";

function assertEqual<T>(
  actual: T,
  expected: T,
  message: string,
): void {
  if (actual !== expected) {
    throw new Error(
      `${message} Expected ${String(expected)}, received ${String(actual)}.`,
    );
  }
}

function main(): void {
  assertEqual(
    resolveExecutionCapability("UNDERSTAND"),
    "AI",
    "UNDERSTAND mapping failed.",
  );

  assertEqual(
    resolveExecutionCapability("RESEARCH"),
    "AI",
    "RESEARCH mapping failed.",
  );

  assertEqual(
    resolveExecutionCapability("CREATE"),
    "CODE",
    "CREATE mapping failed.",
  );

  assertEqual(
    resolveExecutionCapability("MODIFY"),
    "CODE",
    "MODIFY mapping failed.",
  );

  assertEqual(
    resolveExecutionCapability("BUILD"),
    "CODE",
    "BUILD mapping failed.",
  );

  assertEqual(
    resolveExecutionCapability("TEST"),
    "CODE",
    "TEST mapping failed.",
  );

  assertEqual(
    resolveExecutionCapability("VERIFY"),
    "AI",
    "VERIFY mapping failed.",
  );

  assertEqual(
    resolveExecutionCapability("DEPLOY"),
    "DEPLOYMENT",
    "DEPLOY mapping failed.",
  );

  assertEqual(
    resolveExecutionCapability("PUBLISH"),
    "PUBLISH",
    "PUBLISH mapping failed.",
  );

  assertEqual(
    resolveExecutionCapability("AUTOMATE"),
    "AUTOMATION",
    "AUTOMATE mapping failed.",
  );

  assertEqual(
    resolveExecutionCapability("CONTROL"),
    "AI",
    "CONTROL mapping failed.",
  );

  assertEqual(
    resolveExecutionCapability("UNKNOWN_ACTION"),
    "AI",
    "Unknown-action fallback failed.",
  );

  console.log("STEP 39 capability resolver test: PASS");

  console.log({
    actionRouting: true,
    unknownActionFallback: true,
    deterministic: true,
  });
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exitCode = 1;
}
