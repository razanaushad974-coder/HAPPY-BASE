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

const readyTasks = graphEngine.getReadyTasks(
  readySnapshot.graph,
);

if (readyTasks.length !== 1) {
  throw new Error("Ready task calculation failed.");
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

const failed = missionEngine.updateTaskStatus(
  mission,
  tasks,
  nextReady[0].id,
  "FAILED",
);

const retriableTask = failed.tasks.find(
  (task) => task.id === nextReady[0].id,
);

if (!retriableTask) {
  throw new Error("Failed task missing.");
}

const retried = missionEngine.retryTask(retriableTask);

if (
  retried.status !== "PENDING" ||
  retried.retryCount !== 1
) {
  throw new Error("Task retry handling failed.");
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
  retryCount: retried.retryCount,
});

