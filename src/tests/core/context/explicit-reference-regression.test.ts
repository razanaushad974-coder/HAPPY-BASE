import {
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

function main(): void {
  const baseContext = {
    userId:
      "user-a",
    workspaceId:
      "workspace-a",
    activeProjectId:
      "project-happy",
    activeMissionId:
      "mission-001",
    activeTaskId:
      "task-001",
  };

  // ==============================================
  // EXPLICIT PROJECT
  // ==============================================

  const project =
    resolveContext(
      {
        ...baseContext,
        recentCommand:
          "deploy this project to production",
      },
      "deploy this project to production",
    );

  assert(
    project.resolvedReferences.some(
      (reference) =>
        reference.entityType ===
          "PROJECT" &&
        reference.entityId ===
          "project-happy",
    ),
    "Explicit project reference was not resolved.",
  );

  assert(
    !project.unresolvedReferences.includes(
      "ambiguous_entity",
    ),
    "Explicit project reference incorrectly triggered ambiguous_entity.",
  );

  assert(
    project.requiresClarification === false,
    "Explicit project reference incorrectly requires clarification.",
  );

  // ==============================================
  // EXPLICIT MISSION
  // ==============================================

  const mission =
    resolveContext(
      {
        ...baseContext,
        recentCommand:
          "continue this mission",
      },
      "continue this mission",
    );

  assert(
    mission.resolvedReferences.some(
      (reference) =>
        reference.entityType ===
          "MISSION" &&
        reference.entityId ===
          "mission-001",
    ),
    "Explicit mission reference was not resolved.",
  );

  assert(
    !mission.unresolvedReferences.includes(
      "ambiguous_entity",
    ),
    "Explicit mission reference incorrectly triggered ambiguous_entity.",
  );

  assert(
    mission.requiresClarification === false,
    "Explicit mission reference incorrectly requires clarification.",
  );

  // ==============================================
  // EXPLICIT TASK
  // ==============================================

  const task =
    resolveContext(
      {
        ...baseContext,
        recentCommand:
          "complete that task",
      },
      "complete that task",
    );

  assert(
    task.resolvedReferences.some(
      (reference) =>
        reference.entityType ===
          "TASK" &&
        reference.entityId ===
          "task-001",
    ),
    "Explicit task reference was not resolved.",
  );

  assert(
    !task.unresolvedReferences.includes(
      "ambiguous_entity",
    ),
    "Explicit task reference incorrectly triggered ambiguous_entity.",
  );

  assert(
    task.requiresClarification === false,
    "Explicit task reference incorrectly requires clarification.",
  );

  // ==============================================
  // GENERIC REFERENCES MUST REMAIN SAFE
  // ==============================================

  const generic =
    resolveContext(
      {
        ...baseContext,
        recentCommand:
          "isko deploy karo",
      },
      "isko deploy karo",
    );

  assert(
    generic.unresolvedReferences.includes(
      "ambiguous_entity",
    ),
    "Generic ambiguous reference was unexpectedly auto-resolved.",
  );

  assert(
    generic.requiresClarification === true,
    "Generic ambiguous reference did not require clarification.",
  );

  console.log(
    "STEP 34 explicit-reference control-flow test: PASS",
  );

  console.log({
    explicitProjectResolved:
      true,
    explicitMissionResolved:
      true,
    explicitTaskResolved:
      true,
    explicitReferencesDoNotTriggerAmbiguity:
      true,
    genericAmbiguityStillBlocked:
      true,
  });
}

try {
  main();
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}
