import type { ResolvedReference } from "../../../core/context/types";
import {
  resolveExecutionCapability,
} from "../../../core/execution/capability-resolver";

function assert(
  condition: boolean,
  message: string,
): void {
  if (!condition) {
    throw new Error(message);
  }
}

function main(): void {
  const apiActions = [
    "REQUEST",
    "CALL",
    "GET",
    "POST",
    "PUT",
    "PATCH",
    "DELETE",
  ];

  for (const action of apiActions) {
    assert(
      resolveExecutionCapability(action) === "API",
      `Expected ${action} to resolve to API.`,
    );
  }

  const fileTarget: ResolvedReference = {
    token: "test-file",
    entityType: "FILE",
    entityId: "file-001",
    confidence: "HIGH",
    source: "ACTIVE_CONTEXT",
  };

  assert(
    resolveExecutionCapability(
      "CREATE",
      fileTarget,
    ) === "FILE",
    "FILE CREATE routing regressed.",
  );

  assert(
    resolveExecutionCapability(
      "MODIFY",
      fileTarget,
    ) === "FILE",
    "FILE MODIFY routing regressed.",
  );

  assert(
    resolveExecutionCapability(
      "BUILD",
    ) === "CODE",
    "BUILD should still route to CODE.",
  );

  assert(
    resolveExecutionCapability(
      "TEST",
    ) === "CODE",
    "TEST should still route to CODE.",
  );

  assert(
    resolveExecutionCapability(
      "PUBLISH",
    ) === "PUBLISH",
    "PUBLISH routing regressed.",
  );

  console.log(
    "STEP 39 API routing test: PASS",
  );

  console.log({
    request: true,
    call: true,
    get: true,
    post: true,
    put: true,
    patch: true,
    delete: true,
    fileRoutingPreserved: true,
    codeRoutingPreserved: true,
    publishRoutingPreserved: true,
  });
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
