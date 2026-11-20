import { ReasoningOrchestrator } from "../../../core/reasoning/orchestrator";
import { MissionOrchestrator } from "../../../core/mission/orchestrator";
import { TaskGraphEngine } from "../../../core/mission/task-graph";
import { MissionEngine } from "../../../core/mission/mission-engine";
import type { MissionTask } from "../../../core/mission/types";
import type { ResolvedReference } from "../../../core/context/types";

const reasoning = new ReasoningOrchestrator();
const missions = new MissionOrchestrator();
const graphEngine = new TaskGraphEngine();
const missionEngine = new MissionEngine();

const plan = reasoning.createExecutionPlan({
  goal: "Build a secure Founder Dashboard API for HAPPY.",
  contextSummary:
    "Founder Dashboard is the privileged control center.",
  resolvedReferences: [
    {
      token: "this project",
      entityType: "PROJECT",
      entityId: "project-happy",
      confidence: "HIGH",
      source: "ACTIVE_CONTEXT",
    },
  ],
  constraints: [
    "Security and approval gates are mandatory.",
  ],
  requiredCapabilities: [
    "API builder",
    "Testing",
    "Verification",
  ],
});

if (plan.status !== "WAITING_APPROVAL") {
  throw new Error("Expected approval-gated plan.");
}

const snapshot = missions.create(plan);
    const buildTask =
        snapshot.graph.tasks.find(
            (task) =>
                task.action ===
                "BUILD",
        );

    const missionBuildTargetPreserved =
        buildTask?.targetReference?.entityId ===
            "project-happy";

    if (!missionBuildTargetPreserved) {
        throw new Error(
            "Mission BUILD task lost the resolved project target.",
        );
    }


if (snapshot.mission.status !== "WAITING_APPROVAL") {
  throw new Error("Mission approval state failed.");
}

if (snapshot.graph.tasks.length !== 5) {
  throw new Error("Mission task creation failed.");
}

if (snapshot.graph.roots.length !== 1) {
  throw new Error("Root task calculation failed.");
}

if (snapshot.graph.leaves.length !== 1) {
  throw new Error("Leaf task calculation failed.");
}

const firstTask = snapshot.graph.tasks.find(
  (task) => task.order === 1,
);

if (!firstTask) {
  throw new Error("First task missing.");
}

if (firstTask.dependencyIds.length !== 0) {
  throw new Error("Root task has an unexpected dependency.");
}

const secondTask = snapshot.graph.tasks.find(
  (task) => task.order === 2,
);

if (!secondTask) {
  throw new Error("Second task missing.");
}

if (!secondTask.dependencyIds.includes(firstTask.id)) {
  throw new Error("Task dependency chain failed.");
}

const invalidTasks: MissionTask[] = [
  {
    ...firstTask,
    id: "cycle-a",
    dependencyIds: ["cycle-b"],
  },
  {
    ...secondTask,
    id: "cycle-b",
    dependencyIds: ["cycle-a"],
  },
];

if (!graphEngine.hasCycle(invalidTasks)) {
  throw new Error("Cycle detection failed.");
}

const crossMissionTasks: MissionTask[] = [
  { ...firstTask, id: "cross-mission-a", dependencyIds: [] },
  {
    ...secondTask,
    id: "cross-mission-b",
    missionId: "different-mission",
    dependencyIds: ["cross-mission-a"],
  },
];
if (graphEngine.validate(crossMissionTasks).valid) {
  throw new Error("Cross-mission task graph was accepted.");
}

const duplicateDependencyTasks: MissionTask[] = [
  {
    ...firstTask,
    id: "duplicate-dependency-task",
    dependencyIds: ["duplicate-dependency-root", "duplicate-dependency-root"],
  },
  {
    ...secondTask,
    id: "duplicate-dependency-root",
    dependencyIds: [],
  },
];
if (graphEngine.validate(duplicateDependencyTasks).valid) {
  throw new Error("Duplicate task dependency was accepted.");
}

const blockedPlan = reasoning.createExecutionPlan({
  goal: "Build an application.",
  unresolvedQuestions: [
    "Which environment should be used?",
  ],
});

if (blockedPlan.status !== "NEEDS_CLARIFICATION") {
  throw new Error("Clarification plan creation failed.");
}

const readyPlan = reasoning.createExecutionPlan({
  goal: "Create a documentation file.",
});

if (readyPlan.status !== "READY") {
  throw new Error("Expected non-blocked ready plan.");
}

const readySnapshot = missions.create(readyPlan);

let incompleteMissionSnapshotDenied = false;
try {
  missionEngine.updateTaskStatus(
    readySnapshot.mission,
    readySnapshot.graph.tasks.slice(0, -1),
    readySnapshot.graph.tasks[0].id,
    "RUNNING",
  );
} catch {
  incompleteMissionSnapshotDenied = true;
}
if (!incompleteMissionSnapshotDenied) {
  throw new Error("MissionEngine accepted an incomplete task snapshot.");
}

let foreignTaskInMissionSnapshotDenied = false;
try {
  missionEngine.updateTaskStatus(
    readySnapshot.mission,
    [
      ...readySnapshot.graph.tasks,
      {
        ...readySnapshot.graph.tasks[0],
        id: "undeclared-extra-task",
      },
    ],
    readySnapshot.graph.tasks[0].id,
    "RUNNING",
  );
} catch {
  foreignTaskInMissionSnapshotDenied = true;
}
if (!foreignTaskInMissionSnapshotDenied) {
  throw new Error("MissionEngine accepted an undeclared task in the mission snapshot.");
}

let duplicateMissionTaskIdsDenied = false;
try {
  missionEngine.updateTaskStatus(
    {
      ...readySnapshot.mission,
      taskIds: [
        ...readySnapshot.mission.taskIds,
        readySnapshot.mission.taskIds[0],
      ],
    },
    readySnapshot.graph.tasks,
    readySnapshot.graph.tasks[0].id,
    "RUNNING",
  );
} catch {
  duplicateMissionTaskIdsDenied = true;
}
if (!duplicateMissionTaskIdsDenied) {
  throw new Error("MissionEngine accepted duplicate IDs in mission.taskIds.");
}

for (const blockedMissionStatus of [
  "WAITING_APPROVAL",
  "CANCELLED",
  "FAILED",
  "BLOCKED",
] as const) {
  let executionDenied = false;
  try {
    missionEngine.updateTaskStatus(
      { ...readySnapshot.mission, status: blockedMissionStatus },
      readySnapshot.graph.tasks,
      readySnapshot.graph.tasks[0].id,
      "RUNNING",
    );
  } catch {
    executionDenied = true;
  }
  if (!executionDenied) {
    throw new Error(
      `MissionEngine allowed task execution while mission was ${blockedMissionStatus}.`,
    );
  }
}

const readyTasks = graphEngine.getReadyTasks(
  readySnapshot.graph,
);

if (readyTasks.length !== 1) {
  throw new Error("Ready task calculation failed.");
}

const dependentBeforePrerequisite = readySnapshot.graph.tasks.find(
  (task) => task.dependencyIds.length > 0,
);
if (!dependentBeforePrerequisite) {
  throw new Error("Expected a dependent task in the ready mission graph.");
}
let prematureStartDenied = false;
try {
  missionEngine.updateTaskStatus(
    readySnapshot.mission,
    readySnapshot.graph.tasks,
    dependentBeforePrerequisite.id,
    "RUNNING",
  );
} catch {
  prematureStartDenied = true;
}
if (!prematureStartDenied) {
  throw new Error("MissionEngine allowed a dependent task to start before its prerequisite completed.");
}

let ambiguousTaskIdentityDenied = false;
try {
  missionEngine.updateTaskStatus(
    readySnapshot.mission,
    [
      ...readySnapshot.graph.tasks,
      { ...readySnapshot.graph.tasks[0] },
    ],
    readySnapshot.graph.tasks[0].id,
    "RUNNING",
  );
} catch {
  ambiguousTaskIdentityDenied = true;
}
if (!ambiguousTaskIdentityDenied) {
  throw new Error("MissionEngine accepted duplicate persisted task IDs.");
}

let mission = readySnapshot.mission;
let tasks = readySnapshot.graph.tasks;

const firstReadyTask = readyTasks[0];

const running = missionEngine.updateTaskStatus(
  mission,
  tasks,
  firstReadyTask.id,
  "RUNNING",
);

mission = running.mission;
tasks = running.tasks;

if (mission.status !== "RUNNING") {
  throw new Error("Mission RUNNING state failed.");
}

const verifyingFirst = missionEngine.updateTaskStatus(
  mission,
  tasks,
  firstReadyTask.id,
  "VERIFYING",
);
mission = verifyingFirst.mission;
tasks = verifyingFirst.tasks;

const completed = missionEngine.updateTaskStatus(
  mission,
  tasks,
  firstReadyTask.id,
  "COMPLETED",
);

mission = completed.mission;
tasks = completed.tasks;

if (mission.progressPercent !== 20) {
  throw new Error("Mission progress calculation failed.");
}

const nextGraph = graphEngine.buildGraph(tasks);
const nextReady = graphEngine.getReadyTasks(nextGraph);

if (nextReady.length !== 1) {
  throw new Error("Dependency-based readiness failed.");
}

const runningSecond = missionEngine.updateTaskStatus(
  mission,
  tasks,
  nextReady[0].id,
  "RUNNING",
);
const verifyingSecond = missionEngine.updateTaskStatus(
  runningSecond.mission,
  runningSecond.tasks,
  nextReady[0].id,
  "VERIFYING",
);
const failed = missionEngine.updateTaskStatus(
  verifyingSecond.mission,
  verifyingSecond.tasks,
  nextReady[0].id,
  "FAILED",
);

const retried = missionEngine.retryMissionTask(
  failed.mission,
  failed.tasks,
  nextReady[0].id,
);
const retriedTask = retried.tasks.find((task) => task.id === nextReady[0].id);

if (
  retriedTask?.status !== "PENDING" ||
  retriedTask.retryCount !== 1 ||
  retried.mission.status !== "READY" ||
  retried.mission.failedTaskIds.includes(nextReady[0].id)
) {
  throw new Error("Mission retry did not restore a consistent READY state.");
}

let ambiguousRetryIdentityDenied = false;
try {
  missionEngine.retryMissionTask(
    failed.mission,
    [
      ...failed.tasks,
      { ...failed.tasks.find((task) => task.id === nextReady[0].id)! },
    ],
    nextReady[0].id,
  );
} catch {
  ambiguousRetryIdentityDenied = true;
}
if (!ambiguousRetryIdentityDenied) {
  throw new Error("Mission retry accepted duplicate persisted task IDs.");
}

let invalidTransitionDenied = false;
try {
  missionEngine.updateTaskStatus(
    completed.mission,
    completed.tasks,
    firstReadyTask.id,
    "RUNNING",
  );
} catch {
  invalidTransitionDenied = true;
}
if (!invalidTransitionDenied) {
  throw new Error("A completed task was allowed to restart.");
}

console.log("Mission + task graph test: PASS");
console.log({
  missionStatus: snapshot.mission.status,
  tasks: snapshot.graph.tasks.length,
  roots: snapshot.graph.roots.length,
  leaves: snapshot.graph.leaves.length,
  cycleDetection: true,
  dependencyReadiness: true,
  approvalGate:
    snapshot.mission.status === "WAITING_APPROVAL",
  progressAfterFirstTask: completed.mission.progressPercent,
  retryCount: retriedTask?.retryCount,
});



// Multi-branch DAG scheduling: independent roots are both eligible, and a
// dependent task becomes eligible only after its own prerequisite completes.
const branchA = {
  ...firstTask,
  id: "dag-root-a",
  missionId: "dag-mission",
  status: "PENDING" as const,
  dependencyIds: [],
  dependentTaskIds: [],
};
const branchB = {
  ...firstTask,
  id: "dag-root-b",
  missionId: "dag-mission",
  status: "PENDING" as const,
  dependencyIds: [],
  dependentTaskIds: [],
};
const childA = {
  ...firstTask,
  id: "dag-child-a",
  missionId: "dag-mission",
  status: "PENDING" as const,
  dependencyIds: ["dag-root-a"],
  dependentTaskIds: [],
};
const childB = {
  ...firstTask,
  id: "dag-child-b",
  missionId: "dag-mission",
  status: "PENDING" as const,
  dependencyIds: ["dag-root-b"],
  dependentTaskIds: [],
};
const dagTasks = [branchA, branchB, childA, childB];
const initialDag = graphEngine.buildGraph(dagTasks);
const initialReady = graphEngine.getReadyTasks(initialDag);
if (
  initialReady.length !== 2 ||
  !initialReady.some((task) => task.id === "dag-root-a") ||
  !initialReady.some((task) => task.id === "dag-root-b")
) {
  throw new Error("Independent DAG roots were not both scheduled.");
}

const afterRootA = graphEngine.buildGraph(
  dagTasks.map((task) =>
    task.id === "dag-root-a"
      ? { ...task, status: "COMPLETED" as const }
      : task,
  ),
);
const afterRootAReady = graphEngine.getReadyTasks(afterRootA);
if (
  afterRootAReady.length !== 2 ||
  !afterRootAReady.some((task) => task.id === "dag-root-b") ||
  !afterRootAReady.some((task) => task.id === "dag-child-a")
) {
  throw new Error("Completing one root did not release only its dependent branch.");
}

const afterRootBFailure = graphEngine.buildGraph(
  dagTasks.map((task) =>
    task.id === "dag-root-b"
      ? { ...task, status: "FAILED" as const }
      : task,
  ),
);
const afterRootBFailureReady = graphEngine.getReadyTasks(afterRootBFailure);
if (
  afterRootBFailureReady.some((task) => task.id === "dag-child-b")
) {
  throw new Error("A failed prerequisite incorrectly released its dependent task.");
}
