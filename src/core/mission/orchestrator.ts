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
import {
  composeTrustedWorkerRuntime,
  type WorkerRuntimeComposition,
  type WorkerRuntimeCompositionDependencies,
} from "./worker-runtime-composition";
import type { WorkerBrokerOperation } from "./worker-database-broker";

export class MissionOrchestrator {
  private readonly missionEngine = new MissionEngine();
  private readonly graphEngine = new TaskGraphEngine();

  constructor(
    private readonly workerRuntimeDependencies: WorkerRuntimeCompositionDependencies | null = null,
  ) {}

  /**
   * Explicit worker-only authorization seam. The default application
   * orchestrator remains disconnected and continues using its existing
   * mission/task graph behavior; it never falls back to a human session or
   * silently treats in-memory orchestration as durable worker execution.
   */
  prepareWorkerRuntimeOperation(
    operation: WorkerBrokerOperation,
    now?: () => number,
  ): Promise<WorkerRuntimeComposition> {
    if (!this.workerRuntimeDependencies) {
      return Promise.resolve({
        status: "NOT_CONNECTED",
        missing: "IDENTITY_PROVIDER",
      });
    }

    return composeTrustedWorkerRuntime({
      dependencies: this.workerRuntimeDependencies,
      operation,
      ...(now ? { now } : {}),
    });
  }

  create(plan: ExecutionPlan): MissionSnapshot {
    const mission = this.missionEngine.createMission(plan);

    const tasks: MissionTask[] = plan.steps.map(
      (step, index) => ({
        id: mission.taskIds[index],
        missionId: mission.id,
        action: step.action,
        title: step.title,
        description: step.description,
        targetReference: step.targetReference,
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
