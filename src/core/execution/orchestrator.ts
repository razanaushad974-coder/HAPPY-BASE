import type {
  ExecutionRequest,
  ExecutionResult,
} from "./types";

import { ExecutionEngine } from "./engine";

export class ExecutionOrchestrator {
  constructor(
    private readonly engine: ExecutionEngine,
  ) {}

  async runTask(
    request: ExecutionRequest,
  ): Promise<ExecutionResult> {
    return this.engine.execute(request);
  }
}
