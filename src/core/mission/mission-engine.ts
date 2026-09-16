import type {
  ExecutionPlan,
} from "../reasoning/types";

import type {
  Mission,
  MissionTask,
  TaskStatus,
} from "./types";

import { TaskGraphEngine } from "./task-graph";

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
    const target = tasks.find((task) => task.id === taskId);

    if (!target) {
      throw new Error(`Task not found: ${taskId}`);
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

