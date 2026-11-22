import { ReasoningOrchestrator } from "../../../core/reasoning/orchestrator";
import { MissionOrchestrator } from "../../../core/mission/orchestrator";
import { TaskGraphEngine } from "../../../core/mission/task-graph";
import { MissionEngine } from "../../../core/mission/mission-engine";
import type { MissionTask, TaskGraph } from "../../../core/mission/types";
import { assessMissionRecovery } from "../../../core/mission/recovery-assessment";
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

// MissionEngine is a second boundary: callers must not bypass PlanningEngine
// validation by constructing malformed plans directly.
const malformedMissionPlans = [
  { ...readyPlan, goal: "   " },
  { ...readyPlan, steps: [] },
  {
    ...readyPlan,
    steps: readyPlan.steps.map((step, index) =>
      index === 0 ? { ...step, action: "DELETE" as const, requiresApproval: false } : step,
    ),
  },
  {
    ...readyPlan,
    steps: readyPlan.steps.map((step, index) =>
      index === 1 ? { ...step, order: readyPlan.steps[0].order } : step,
    ),
  },
];
for (const malformedPlan of malformedMissionPlans) {
  let malformedPlanDenied = false;
  try {
    missionEngine.createMission(malformedPlan);
  } catch {
    malformedPlanDenied = true;
  }
  if (!malformedPlanDenied) {
    throw new Error("MissionEngine accepted a malformed or approval-downgraded plan.");
  }
}

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

// Direct status transitions must reject malformed dependency graphs even
// when the caller bypasses TaskGraphEngine.buildGraph().
const malformedTransitionSnapshots: Array<[string, MissionTask[]]> = [
  [
    "duplicate dependency",
    readySnapshot.graph.tasks.map((task, index) =>
      index === 1
        ? { ...task, dependencyIds: [readySnapshot.graph.tasks[0].id, readySnapshot.graph.tasks[0].id] }
        : task,
    ),
  ],
  [
    "missing dependency",
    readySnapshot.graph.tasks.map((task, index) =>
      index === 1 ? { ...task, dependencyIds: ["missing-dependency"] } : task,
    ),
  ],
  [
    "dependency cycle",
    readySnapshot.graph.tasks.map((task, index) =>
      index === 0
        ? { ...task, dependencyIds: [readySnapshot.graph.tasks[readySnapshot.graph.tasks.length - 1].id] }
        : task,
    ),
  ],
];

for (const [label, malformedTasks] of malformedTransitionSnapshots) {
  let malformedTransitionDenied = false;
  try {
    missionEngine.updateTaskStatus(
      readySnapshot.mission,
      malformedTasks,
      readySnapshot.graph.tasks[0].id,
      "RUNNING",
    );
  } catch {
    malformedTransitionDenied = true;
  }
  if (!malformedTransitionDenied) {
    throw new Error(`MissionEngine accepted a direct transition with ${label}.`);
  }
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

const malformedRuntimeTaskRecords: unknown[] = [
  { ...firstTask, id: " ", missionId: " " },
  { ...firstTask, dependencyIds: null },
  { ...firstTask, retryCount: -1 },
  { ...firstTask, status: "UNKNOWN" },
];
for (const malformedRecord of malformedRuntimeTaskRecords) {
  if (graphEngine.validate([malformedRecord as MissionTask]).valid) {
    throw new Error("TaskGraphEngine accepted a malformed runtime task record.");
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

let malformedRetryGraphDenied = false;
try {
  missionEngine.retryMissionTask(
    failed.mission,
    failed.tasks.map((task, index) =>
      index === 1
        ? { ...task, dependencyIds: [failed.tasks[0].id, failed.tasks[0].id] }
        : task,
    ),
    nextReady[0].id,
  );
} catch {
  malformedRetryGraphDenied = true;
}
if (!malformedRetryGraphDenied) {
  throw new Error("MissionEngine accepted retry from a graph with duplicate dependencies.");
}

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

for (const nonRetryableMissionStatus of [
  "WAITING_APPROVAL",
  "CANCELLED",
  "COMPLETED",
  "READY",
] as const) {
  let retryDenied = false;
  try {
    missionEngine.retryMissionTask(
      { ...failed.mission, status: nonRetryableMissionStatus },
      failed.tasks,
      nextReady[0].id,
    );
  } catch {
    retryDenied = true;
  }
  if (!retryDenied) {
    throw new Error(
      `MissionEngine allowed retry while mission was ${nonRetryableMissionStatus}.`,
    );
  }
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


// Ready-task selection is also a trust boundary: callers may construct a
// TaskGraph object directly without going through buildGraph().
const malformedReadyGraphs: Array<[string, TaskGraph]> = [
  [
    "duplicate task identity",
    {
      ...initialDag,
      tasks: [...initialDag.tasks, { ...initialDag.tasks[0] }],
    },
  ],
  [
    "missing dependency",
    {
      ...initialDag,
      tasks: initialDag.tasks.map((task, index) =>
        index === 0 ? { ...task, dependencyIds: ["missing-task"] } : task,
      ),
    },
  ],
  [
    "mismatched mission identity",
    { ...initialDag, missionId: "another-mission" },
  ],
];

for (const [label, malformedGraph] of malformedReadyGraphs) {
  let malformedGraphDenied = false;
  try {
    graphEngine.getReadyTasks(malformedGraph);
  } catch {
    malformedGraphDenied = true;
  }
  if (!malformedGraphDenied) {
    throw new Error(`Ready-task selection accepted ${label}.`);
  }
}


// Recovery assessment is read-only and never treats a missing or incomplete
// execution record as proof that a side effect did not happen.
const recoveryMission = readySnapshot.mission;
const recoveryTask = readySnapshot.graph.tasks[0];
const activeRecoveryTasks = readySnapshot.graph.tasks.map((task) =>
  task.id === recoveryTask.id ? { ...task, status: "RUNNING" as const } : task,
);
const missingExecutionAssessment = assessMissionRecovery(
  recoveryMission,
  activeRecoveryTasks,
  [],
);
if (
  missingExecutionAssessment[0]?.disposition !== "RECONCILIATION_REQUIRED" ||
  missingExecutionAssessment[0]?.reason !== "EXECUTION_RECORD_MISSING"
) {
  throw new Error("Recovery assessment did not quarantine a missing execution record.");
}

const unknownExecutionAssessment = assessMissionRecovery(
  recoveryMission,
  activeRecoveryTasks,
  [{
    id: "recovery-execution-running",
    missionId: recoveryMission.id,
    taskId: recoveryTask.id,
    status: "RUNNING",
  }],
);
if (unknownExecutionAssessment[0]?.disposition !== "EXECUTION_OUTCOME_UNKNOWN") {
  throw new Error("Recovery assessment incorrectly treated an in-flight side effect as safe to replay.");
}

const completedExecutionAssessment = assessMissionRecovery(
  recoveryMission,
  activeRecoveryTasks,
  [{
    id: "recovery-execution-completed",
    missionId: recoveryMission.id,
    taskId: recoveryTask.id,
    status: "COMPLETED",
  }],
);
if (completedExecutionAssessment[0]?.disposition !== "VERIFICATION_RESUME_REQUIRED") {
  throw new Error("Recovery assessment did not route completed execution to verification.");
}

const duplicateExecutionAssessment = assessMissionRecovery(
  recoveryMission,
  activeRecoveryTasks,
  [
    { id: "recovery-execution-a", missionId: recoveryMission.id, taskId: recoveryTask.id, status: "RUNNING" },
    { id: "recovery-execution-b", missionId: recoveryMission.id, taskId: recoveryTask.id, status: "RUNNING" },
  ],
);

if (duplicateExecutionAssessment[0]?.reason !== "MULTIPLE_EXECUTION_RECORDS") {
  throw new Error("Recovery assessment did not quarantine ambiguous execution records.");
}

const recoveryStatusCases = [
  { status: "WAITING_APPROVAL" as const, expected: "APPROVAL_REVIEW_REQUIRED" as const },
  { status: "FAILED" as const, expected: "FAILED_EXECUTION_REVIEW_REQUIRED" as const },
  { status: "BLOCKED" as const, expected: "BLOCKED_REVIEW_REQUIRED" as const },
  { status: "NOT_YET_CONNECTED" as const, expected: "BLOCKED_REVIEW_REQUIRED" as const },
  { status: "READY" as const, expected: "RECONCILIATION_REQUIRED" as const },
];
for (const testCase of recoveryStatusCases) {
  const assessment = assessMissionRecovery(
    recoveryMission,
    activeRecoveryTasks,
    [{
      id: `recovery-execution-${testCase.status.toLowerCase()}`,
      missionId: recoveryMission.id,
      taskId: recoveryTask.id,
      status: testCase.status,
    }],
  );
  if (assessment[0]?.disposition !== testCase.expected) {
    throw new Error(`Recovery assessment mapped ${testCase.status} to an unsafe disposition.`);
  }
}

const inactiveRecoveryAssessment = assessMissionRecovery(
  recoveryMission,
  readySnapshot.graph.tasks,
  [],
);
if (inactiveRecoveryAssessment.some((item) => item.disposition !== "NO_RECOVERY_REQUIRED")) {
  throw new Error("Recovery assessment flagged inactive tasks for recovery.");
}

let foreignRecoveryExecutionDenied = false;
try {
  assessMissionRecovery(
    recoveryMission,
    activeRecoveryTasks,
    [{ id: "foreign-execution", missionId: "other-mission", taskId: recoveryTask.id, status: "COMPLETED" }],
  );
} catch {
  foreignRecoveryExecutionDenied = true;
}
if (!foreignRecoveryExecutionDenied) {
  throw new Error("Recovery assessment accepted an execution from another mission.");
}
