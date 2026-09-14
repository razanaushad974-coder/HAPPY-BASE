import type { ResolvedReference } from "../../../core/context/types";

import {
  ReasoningEngine,
} from "../../../core/reasoning/engine";

function assert(
  condition: boolean,
  message: string,
): void {
  if (!condition) {
    throw new Error(message);
  }
}

function main(): void {
  const reasoning =
    new ReasoningEngine();

  const resolvedReferences:
    ResolvedReference[] = [
      {
        token:
          "generic-reference",
        entityType:
          "PROJECT",
        entityId:
          "project-happy",
        confidence:
          "HIGH",
        source:
          "ACTIVE_CONTEXT",
      },
      {
        token:
          "that mission",
        entityType:
          "MISSION",
        entityId:
          "mission-001",
        confidence:
          "HIGH",
        source:
          "ACTIVE_CONTEXT",
      },
    ];

  // ==============================================
  // NORMAL PLAN
  // ==============================================

  const normalPlan =
    reasoning.createPlan(
      reasoning.createRequest({
        goal:
          "Update the active project",
        resolvedReferences,
      }),
    );

  assert(
    normalPlan.resolvedReferences.length === 2,
    "Resolved references were not preserved in normal ExecutionPlan.",
  );

  assert(
    normalPlan.resolvedReferences.some(
      (reference) =>
        reference.entityType === "PROJECT" &&
        reference.entityId === "project-happy",
    ),
    "Project reference missing from normal ExecutionPlan.",
  );

  assert(
    normalPlan.resolvedReferences.some(
      (reference) =>
        reference.entityType === "MISSION" &&
        reference.entityId === "mission-001",
    ),
    "Mission reference missing from normal ExecutionPlan.",
  );
   const buildStep =
     normalPlan.steps.find(
       (step) =>
         step.action === "BUILD",
     );

   assert(
     buildStep?.targetReference?.entityType ===
       "PROJECT",
     "BUILD step did not receive the resolved project target.",
   );

   assert(
     buildStep?.targetReference?.entityId ===
       "project-happy",
     "BUILD step target entity ID is incorrect.",
   );

  // ==============================================
  // CLARIFICATION PLAN
  // ==============================================

  const clarificationPlan =
    reasoning.createPlan(
      reasoning.createRequest({
        goal:
          "Update the active project",
        resolvedReferences,
        unresolvedQuestions: [
          "Which deployment environment?",
        ],
      }),
    );

  assert(
    clarificationPlan.status ===
      "NEEDS_CLARIFICATION",
    "Expected clarification plan status.",
  );

  assert(
    clarificationPlan.resolvedReferences.length === 2,
    "Resolved references were not preserved in clarification ExecutionPlan.",
  );

  console.log(
    "STEP 32 resolved reference → plan test: PASS",
  );

  console.log({
    normalPlanReferences: true,
    clarificationPlanReferences: true,
    projectReferencePreserved: true,
    missionReferencePreserved: true,
    resolvedReferencesFirstClass: true,
  });
}

try {
  main();
} catch (error: unknown) {
  console.error(error);
  process.exitCode = 1;
}

