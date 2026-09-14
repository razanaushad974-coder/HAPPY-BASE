import type {
  ExecutionPlan,
} from "../reasoning/types";

import type {
  Mission,
  MissionSnapshot,
  MissionTask,
} from "./types";

import { MissionEngine } from "./mission-engine";
import { TaskGraphEngine } from "./task-graph";

export class MissionOrchestrator {
  private readonly missionEngine = new MissionEngine();
  private readonly graphEngine = new TaskGraphEngine();

  create(plan: ExecutionPlan): MissionSnapshot {
    const mission = this.missionEngine.createMission(plan);

    const tasks: MissionTask[] = plan.steps.map(
      (step, index) => ({
        id: mission.taskIds[index],
        missionId: mission.id,
        action: step.action,
        title: step.title,
        description: step.description,
        status: "PENDING",
        dependencyIds:
          index === 0
            ? []
            : [mission.taskIds[index - 1]],
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

    const graph = this.graphEngine.buildGraph(tasks);

    return {
      mission,
      graph,
    };
  }
}
