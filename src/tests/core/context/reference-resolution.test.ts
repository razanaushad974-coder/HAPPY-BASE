import {
  buildContext,
  resolveContext,
} from "../../../core/context/resolver";

function assert(
  condition: boolean,
  message: string,
): void {
  if (!condition) {
    throw new Error(message);
  }
}

function expectResolved(
  resolution: ReturnType<typeof resolveContext>,
  entityType: "PROJECT" | "MISSION" | "TASK",
  entityId: string,
): void {
  assert(
    !resolution.requiresClarification,
    "Reference unexpectedly required clarification.",
  );

  const resolved =
    resolution.resolvedReferences.some(
      (reference) =>
        reference.entityType === entityType &&
        reference.entityId === entityId,
    );

  assert(
    resolved,
    `Expected ${entityType}:${entityId} reference was not resolved.`,
  );
}

async function main(): Promise<void> {
  // ==================================================
  // PROJECT
  // ==================================================

  const projectContext =
    resolveContext(
      {
        userId: "user-a",
        workspaceId: "workspace-a",
        activeProjectId:
          "project-happy",
      },
      "isko update karo",
    );

  expectResolved(
    projectContext,
    "PROJECT",
    "project-happy",
  );

  // ==================================================
  // MISSION
  // ==================================================

  const missionContext =
    resolveContext(
      {
        userId: "user-a",
        workspaceId: "workspace-a",
        activeMissionId:
          "mission-001",
      },
      "continue that mission",
    );

  expectResolved(
    missionContext,
    "MISSION",
    "mission-001",
  );

  // ==================================================
  // TASK
  // ==================================================

  const taskContext =
    resolveContext(
      {
        userId: "user-a",
        workspaceId: "workspace-a",
        activeTaskId:
          "task-001",
      },
      "this task complete karo",
    );

  expectResolved(
    taskContext,
    "TASK",
    "task-001",
  );

  // ==================================================
  // UNKNOWN REFERENCE
  // ==================================================

  const unresolved =
    resolveContext(
      {
        userId: "user-a",
        workspaceId: "workspace-a",
      },
      "isko update karo",
    );

  assert(
    unresolved.requiresClarification,
    "Unknown reference should require clarification.",
  );

  assert(
    unresolved.unresolvedReferences.includes(
      "referenced_entity",
    ),
    "Unknown reference should report referenced_entity.",
  );

  // ==================================================
  // AMBIGUOUS REFERENCE
  // ==================================================

  const ambiguous =
    resolveContext(
      {
        userId: "user-a",
        workspaceId: "workspace-a",
        activeProjectId:
          "project-happy",
        activeMissionId:
          "mission-001",
      },
      "isko update karo",
    );

  assert(
    ambiguous.requiresClarification,
    "Multiple active candidates must not be guessed.",
  );

  assert(
    ambiguous.unresolvedReferences.includes(
      "ambiguous_entity",
    ),
    "Ambiguous reference must report ambiguous_entity.",
  );

  // ==================================================
  // WRONG ENTITY MUST NOT RESOLVE
  // ==================================================

  const missionOnly =
    resolveContext(
      {
        userId: "user-a",
        workspaceId: "workspace-a",
        activeMissionId:
          "mission-001",
      },
      "this project publish karo",
    );

  assert(
    missionOnly.requiresClarification,
    "Missing project must require clarification.",
  );

  // ==================================================
  // OUTPUT
  // ==================================================

  console.log(
    "STEP 29 persisted entity reference resolution test: PASS",
  );

  console.log({
    resolvedReferencesStructured: true,
  });

  console.log({
    projectReferenceResolved: true,
    missionReferenceResolved: true,
    taskReferenceResolved: true,
    unknownReferenceBlocked: true,
    ambiguousReferenceBlocked: true,
    wrongEntityBlocked: true,
  });
}

main().catch(
  (error: unknown) => {
    console.error(error);
    process.exitCode = 1;
  },
);

