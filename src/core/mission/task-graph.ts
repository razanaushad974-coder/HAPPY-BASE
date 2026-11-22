import type {
  MissionTask,
  TaskGraph,
} from "./types";

export class TaskGraphEngine {
  validate(tasks: MissionTask[]): {
    valid: boolean;
    errors: string[];
  } {
    const errors: string[] = [];
    const ids = new Set<string>();

    const allowedActions = new Set([
      "UNDERSTAND", "RESEARCH", "CREATE", "MODIFY", "BUILD", "TEST",
      "REQUEST", "CALL", "GET", "POST", "PUT", "PATCH", "DELETE",
      "VERIFY", "DEPLOY", "PUBLISH", "AUTOMATE", "CONTROL",
      "DB_SELECT", "DB_QUERY", "DB_INSERT", "DB_UPDATE", "DB_DELETE",
      "DB_TRANSACTION",
    ]);
    const allowedStatuses = new Set([
      "PENDING", "BLOCKED", "READY", "RUNNING", "VERIFYING",
      "COMPLETED", "FAILED", "CANCELLED",
    ]);

    for (const task of tasks) {
      if (typeof task.id !== "string" || !task.id.trim()) {
        errors.push("Task ID must be a non-empty string.");
      } else if (ids.has(task.id)) {
        errors.push(`Duplicate task ID: ${task.id}`);
      }
      if (typeof task.missionId !== "string" || !task.missionId.trim()) {
        errors.push(`Task ${task.id || "<unknown>"} has an empty mission ID.`);
      }
      if (typeof task.title !== "string" || !task.title.trim()) {
        errors.push(`Task ${task.id || "<unknown>"} has an empty title.`);
      }
      if (!allowedActions.has(task.action)) {
        errors.push(`Task ${task.id || "<unknown>"} has an unsupported action.`);
      }
      if (!allowedStatuses.has(task.status)) {
        errors.push(`Task ${task.id || "<unknown>"} has an unsupported status.`);
      }
      if (!Number.isInteger(task.order) || task.order < 1) {
        errors.push(`Task ${task.id || "<unknown>"} has an invalid order.`);
      }
      if (
        !Number.isInteger(task.retryCount) ||
        !Number.isInteger(task.maxRetries) ||
        task.retryCount < 0 ||
        task.maxRetries < 0 ||
        task.retryCount > task.maxRetries
      ) {
        errors.push(`Task ${task.id || "<unknown>"} has invalid retry counters.`);
      }
      if (typeof task.requiresApproval !== "boolean" ||
          typeof task.verificationRequired !== "boolean") {
        errors.push(`Task ${task.id || "<unknown>"} has invalid security flags.`);
      }
      if (!Array.isArray(task.dependencyIds)) {
        errors.push(`Task ${task.id || "<unknown>"} has invalid dependencies.`);
      } else if (typeof task.id === "string" && task.id.trim()) {
        ids.add(task.id);
      }
    }

    const missionIds = new Set(tasks.map((task) => task.missionId));
    if (missionIds.size > 1) {
      errors.push("Task graph cannot contain tasks from multiple missions.");
    }

    for (const task of tasks) {
      const dependencyIds = new Set<string>();
      for (const dependencyId of task.dependencyIds) {
        if (dependencyIds.has(dependencyId)) {
          errors.push(
            `Task ${task.id} contains duplicate dependency ${dependencyId}.`,
          );
        }
        dependencyIds.add(dependencyId);

        if (!ids.has(dependencyId)) {
          errors.push(
            `Task ${task.id} references missing dependency ${dependencyId}.`,
          );
        }

        if (dependencyId === task.id) {
          errors.push(
            `Task ${task.id} cannot depend on itself.`,
          );
        }
      }
    }

    const cycleDetected = this.hasCycle(tasks);

    if (cycleDetected) {
      errors.push("Task graph contains a dependency cycle.");
    }

    return {
      valid: errors.length === 0,
      errors,
    };
  }

  hasCycle(tasks: MissionTask[]): boolean {
    const byId = new Map(tasks.map((task) => [task.id, task]));
    const visiting = new Set<string>();
    const visited = new Set<string>();

    const visit = (id: string): boolean => {
      if (visiting.has(id)) {
        return true;
      }

      if (visited.has(id)) {
        return false;
      }

      visiting.add(id);

      const task = byId.get(id);

      if (task) {
        for (const dependencyId of task.dependencyIds) {
          if (visit(dependencyId)) {
            return true;
          }
        }
      }

      visiting.delete(id);
      visited.add(id);

      return false;
    };

    for (const task of tasks) {
      if (visit(task.id)) {
        return true;
      }
    }

    return false;
  }

  buildGraph(tasks: MissionTask[]): TaskGraph {
    const validation = this.validate(tasks);

    if (!validation.valid) {
      throw new Error(
        `Invalid task graph: ${validation.errors.join(" | ")}`,
      );
    }

    const roots = tasks
      .filter((task) => task.dependencyIds.length === 0)
      .map((task) => task.id);

    const dependentMap = new Map<string, string[]>();

    for (const task of tasks) {
      dependentMap.set(task.id, []);
    }

    for (const task of tasks) {
      for (const dependencyId of task.dependencyIds) {
        dependentMap.get(dependencyId)?.push(task.id);
      }
    }

    const normalizedTasks = tasks.map((task) => ({
      ...task,
      dependentTaskIds: dependentMap.get(task.id) ?? [],
    }));

    const leaves = normalizedTasks
      .filter((task) => task.dependentTaskIds.length === 0)
      .map((task) => task.id);

    return {
      missionId: tasks[0]?.missionId ?? "",
      tasks: normalizedTasks,
      roots,
      leaves,
    };
  }

  getReadyTasks(graph: TaskGraph): MissionTask[] {
    const validation = this.validate(graph.tasks);
    if (!validation.valid) {
      throw new Error(
        `Invalid task graph: ${validation.errors.join(" | ")}`,
      );
    }

    if (
      graph.tasks.length > 0 &&
      graph.missionId !== graph.tasks[0].missionId
    ) {
      throw new Error(
        "Task graph mission ID does not match its task snapshot.",
      );
    }

    const completed = new Set(
      graph.tasks
        .filter((task) => task.status === "COMPLETED")
        .map((task) => task.id),
    );

    return graph.tasks.filter((task) => {
      if (task.status !== "PENDING" && task.status !== "READY") {
        return false;
      }

      return task.dependencyIds.every((dependencyId) =>
        completed.has(dependencyId),
      );
    });
  }

  getParallelReadyGroups(
    graph: TaskGraph,
  ): MissionTask[][] {
    const ready = this.getReadyTasks(graph);
    const groups = new Map<number, MissionTask[]>();

    for (const task of ready) {
      const existing = groups.get(task.order) ?? [];
      existing.push(task);
      groups.set(task.order, existing);
    }

    return [...groups.entries()]
      .sort(([a], [b]) => a - b)
      .map(([, tasksAtOrder]) => tasksAtOrder);
  }
}
