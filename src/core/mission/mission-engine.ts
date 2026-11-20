import type {
  ExecutionPlan,
} from "../reasoning/types";

import type {
  Mission,
  MissionTask,
  TaskStatus,
} from "./types";

import { TaskGraphEngine } from "./task-graph";
const ALLOWED_TASK_TRANSITIONS: Record<TaskStatus, readonly TaskStatus[]> = {
  PENDING: ["READY", "RUNNING", "BLOCKED", "CANCELLED"],
  READY: ["RUNNING", "BLOCKED", "CANCELLED"],
  RUNNING: ["VERIFYING", "FAILED", "BLOCKED", "CANCELLED"],
  VERIFYING: ["COMPLETED", "FAILED", "BLOCKED", "CANCELLED"],
  COMPLETED: [],
  FAILED: [],
  BLOCKED: [],
  CANCELLED: [],
};


function assertMissionTaskSnapshot(
  mission: Mission,
  tasks: MissionTask[],
): void {
  const declaredIds = new Set(mission.taskIds);
  if (declaredIds.size !== mission.taskIds.length) {
    throw new Error(`Mission ${mission.id} contains duplicate task IDs.`);
  }

  const persistedIds = new Set<string>();
  for (const task of tasks) {
    if (task.missionId !== mission.id || !declaredIds.has(task.id)) {
      throw new Error(
        `Task snapshot contains a task outside mission ${mission.id}: ${task.id}`,
      );
    }
    if (persistedIds.has(task.id)) {
      throw new Error(`Task snapshot contains duplicate task ID: ${task.id}`);
    }
    persistedIds.add(task.id);
  }

  if (
    persistedIds.size !== declaredIds.size ||
    [...declaredIds].some((taskId) => !persistedIds.has(taskId))
  ) {
    throw new Error(
      `Task snapshot is incomplete for mission ${mission.id}; every declared task must be present exactly once.`,
    );
  }
}

export class MissionEngine {
  private readonly graphEngine = new TaskGraphEngine();

  createMission(plan: ExecutionPlan): Mission {
    if (
      plan.status !== "READY" &&
      plan.status !== "WAITING_APPROVAL"
    ) {
      throw new Error(
        `Execution plan cannot create mission from status ${plan.status}.`,
      );
    }

    const taskIds = plan.steps.map(() => crypto.randomUUID());

    const tasks: MissionTask[] = plan.steps.map(
      (step, index) => ({
        id: taskIds[index],
        missionId: "",
        action: step.action,
        title: step.title,
        description: step.description,
        targetReference: step.targetReference,
        status: "PENDING",
        dependencyIds:
          index === 0 ? [] : [taskIds[index - 1]],
        dependentTaskIds: [],
        order: step.order,
        retryCount: 0,
        maxRetries: 3,
        requiresApproval: step.requiresApproval,
        verificationRequired: step.verificationRequired,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      }),
    );

    const missionId = crypto.randomUUID();

    const missionTasks = tasks.map((task) => ({
      ...task,
      missionId,
    }));

    const graph = this.graphEngine.buildGraph(missionTasks);

    return {
      id: missionId,
      goal: plan.goal,
      planId: plan.id,
      status:
        plan.status === "WAITING_APPROVAL"
          ? "WAITING_APPROVAL"
          : "READY",
      taskIds: graph.tasks.map((task) => task.id),
      rootTaskIds: graph.roots,
      completedTaskIds: [],
      failedTaskIds: [],
      blockedTaskIds: [],
      progressPercent: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    };
  }

  updateTaskStatus(
    mission: Mission,
    tasks: MissionTask[],
    taskId: string,
    status: TaskStatus,
  ): {
    mission: Mission;
    tasks: MissionTask[];
  } {
    assertMissionTaskSnapshot(mission, tasks);
    const matchingTasks = tasks.filter((task) => task.id === taskId);
    if (matchingTasks.length !== 1) {
      throw new Error(
        matchingTasks.length === 0
          ? `Task not found: ${taskId}`
          : `Task ID is ambiguous in the supplied mission snapshot: ${taskId}`,
      );
    }
    const target = matchingTasks[0];
    if (target.missionId !== mission.id || !mission.taskIds.includes(taskId)) {
      throw new Error(`Task ${taskId} does not belong to mission ${mission.id}.`);
    }
    if (target.status !== status &&
        !ALLOWED_TASK_TRANSITIONS[target.status].includes(status)) {
      throw new Error(
        `Invalid task status transition: ${target.status} -> ${status}.`,
      );
    }

    // The transition API is also a trust boundary: callers must not be able
    // to bypass TaskGraphEngine scheduling by starting a dependent task early.
    if (status === "RUNNING" && target.status !== "RUNNING") {
      const dependencies = target.dependencyIds.map((dependencyId) => ({
        id: dependencyId,
        matches: tasks.filter((task) => task.id === dependencyId),
      }));
      if (dependencies.some(({ id, matches }) =>
        matches.length !== 1 ||
        matches[0].missionId !== mission.id ||
        !mission.taskIds.includes(id) ||
        matches[0].status !== "COMPLETED"
      )) {
        throw new Error(
          `Task ${taskId} cannot run until every mission dependency is completed.`,
        );
      }
    }
    if (target.status === status) {
      return { mission, tasks };
    }

    const updatedTasks = tasks.map((task) =>
      task.id === taskId
        ? {
            ...task,
            status,
            updatedAt: new Date().toISOString(),
          }
        : task,
    );

    const completedTaskIds = updatedTasks
      .filter((task) => task.status === "COMPLETED")
      .map((task) => task.id);

    const failedTaskIds = updatedTasks
      .filter((task) => task.status === "FAILED")
      .map((task) => task.id);

    const blockedTaskIds = updatedTasks
      .filter((task) => task.status === "BLOCKED")
      .map((task) => task.id);

    const total = updatedTasks.length;
    const progressPercent =
      total === 0
        ? 0
        : Math.round(
            (completedTaskIds.length / total) * 100,
          );

    let missionStatus = mission.status;

    if (failedTaskIds.length > 0) {
      missionStatus = "FAILED";
    } else if (blockedTaskIds.length > 0) {
      missionStatus = "BLOCKED";
    } else if (
      total > 0 &&
      completedTaskIds.length === total
    ) {
      missionStatus = "COMPLETED";
    } else if (
      updatedTasks.some(
        (task) => task.status === "RUNNING",
      )
    ) {
      missionStatus = "RUNNING";
    } else if (
      updatedTasks.some(
        (task) => task.status === "VERIFYING",
      )
    ) {
      missionStatus = "VERIFYING";
    }

    return {
      mission: {
        ...mission,
        status: missionStatus,
        completedTaskIds,
        failedTaskIds,
        blockedTaskIds,
        progressPercent,
        updatedAt: new Date().toISOString(),
      },
      tasks: updatedTasks,
    };
  }

  retryMissionTask(
    mission: Mission,
    tasks: MissionTask[],
    taskId: string,
  ): { mission: Mission; tasks: MissionTask[] } {
    assertMissionTaskSnapshot(mission, tasks);
    const matchingTasks = tasks.filter((item) => item.id === taskId);
    if (matchingTasks.length !== 1) {
      throw new Error(
        matchingTasks.length === 0
          ? `Task not found: ${taskId}`
          : `Task ID is ambiguous in the supplied mission snapshot: ${taskId}`,
      );
    }
    const task = matchingTasks[0];
    if (task.missionId !== mission.id || !mission.taskIds.includes(taskId)) {
      throw new Error(`Task ${taskId} does not belong to mission ${mission.id}.`);
    }

    const retriedTask = this.retryTask(task);
    const updatedTasks = tasks.map((item) =>
      item.id === taskId ? retriedTask : item,
    );
    const completedTaskIds = updatedTasks
      .filter((item) => item.status === "COMPLETED")
      .map((item) => item.id);
    const failedTaskIds = updatedTasks
      .filter((item) => item.status === "FAILED")
      .map((item) => item.id);
    const blockedTaskIds = updatedTasks
      .filter((item) => item.status === "BLOCKED")
      .map((item) => item.id);
    const total = updatedTasks.length;

    let status = mission.status;
    if (failedTaskIds.length > 0) status = "FAILED";
    else if (blockedTaskIds.length > 0) status = "BLOCKED";
    else if (total > 0 && completedTaskIds.length === total) status = "COMPLETED";
    else if (updatedTasks.some((item) => item.status === "RUNNING")) status = "RUNNING";
    else if (updatedTasks.some((item) => item.status === "VERIFYING")) status = "VERIFYING";
    else status = "READY";

    return {
      mission: {
        ...mission,
        status,
        completedTaskIds,
        failedTaskIds,
        blockedTaskIds,
        progressPercent: total === 0 ? 0 : Math.round((completedTaskIds.length / total) * 100),
        updatedAt: new Date().toISOString(),
      },
      tasks: updatedTasks,
    };
  }

  retryTask(
    task: MissionTask,
  ): MissionTask {
    if (task.status !== "FAILED") {
      throw new Error(
        "Only failed tasks can be retried.",
      );
    }

    if (task.retryCount >= task.maxRetries) {
      throw new Error(
        `Task ${task.id} exceeded retry limit.`,
      );
    }

    return {
      ...task,
      status: "PENDING",
      retryCount: task.retryCount + 1,
      updatedAt: new Date().toISOString(),
    };
  }
}

