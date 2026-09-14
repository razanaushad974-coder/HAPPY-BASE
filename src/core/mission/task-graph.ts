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

    for (const task of tasks) {
      if (ids.has(task.id)) {
        errors.push(`Duplicate task ID: ${task.id}`);
      }

      ids.add(task.id);
    }

    for (const task of tasks) {
      for (const dependencyId of task.dependencyIds) {
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

    const taskMap = new Map(
      tasks.map((task) => [task.id, task]),
    );

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
