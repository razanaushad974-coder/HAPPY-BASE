import { buildContext, resolveContext } from "@/core/context/resolver";

const context = buildContext({
  userId: "user-test",
  workspaceId: "workspace-test",
  activeProjectId: "project-happy",
  activeMissionId: "mission-001",
  recentCommand: "Create a website",
  language: "en",
});

if (context.activeProject?.value !== "project-happy") {
  throw new Error("Active project context was not resolved.");
}

if (context.activeMission?.value !== "mission-001") {
  throw new Error("Active mission context was not resolved.");
}

const resolved = resolveContext(
  {
    userId: "user-test",
    workspaceId: "workspace-test",
    activeProjectId: "project-happy",
  },
  "isko update karo",
);

if (resolved.requiresClarification) {
  throw new Error(
    "A single known active project should allow reference resolution.",
  );
}

if (
  !resolved.resolvedReferences.some(
    (reference) =>
      reference.entityType === "PROJECT" &&
      reference.entityId === "project-happy",
  )
) {
  throw new Error(
    "The active project was not resolved as the referenced entity.",
  );
}

const unresolved = resolveContext(
  {
    userId: "user-test",
    workspaceId: "workspace-test",
  },
  "isko update karo",
);

if (!unresolved.requiresClarification) {
  throw new Error(
    "Unknown reference should require clarification.",
  );
}

const ambiguous = resolveContext(
  {
    userId: "user-test",
    workspaceId: "workspace-test",
    activeProjectId: "project-happy",
    activeMissionId: "mission-001",
  },
  "isko update karo",
);

if (!ambiguous.requiresClarification) {
  throw new Error(
    "Multiple active entities should require clarification.",
  );
}

if (
  !ambiguous.unresolvedReferences.includes(
    "ambiguous_entity",
  )
) {
  throw new Error(
    "Ambiguous reference must report ambiguous_entity.",
  );
}

if (
  !unresolved.unresolvedReferences.includes(
    "referenced_entity",
  )
) {
  throw new Error(
    "Unknown reference must report referenced_entity.",
  );
}

console.log("Context engine test: PASS");
console.log({
  resolved: resolved.requiresClarification,
  unresolved: unresolved.requiresClarification,
});


