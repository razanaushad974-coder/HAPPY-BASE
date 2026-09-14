import type {
  ExecutionAdapter,
  ExecutionCapability,
  ExecutionRequest,
} from "./types";

export class ExecutionAdapterRegistry {
  private readonly adapters = new Map<
    ExecutionCapability,
    ExecutionAdapter
  >();

  register(adapter: ExecutionAdapter): void {
    this.adapters.set(adapter.capability, adapter);
  }

  get(
    capability: ExecutionCapability,
  ): ExecutionAdapter | undefined {
    return this.adapters.get(capability);
  }

  list(): ExecutionAdapter[] {
    return [...this.adapters.values()];
  }

  canExecute(
    request: ExecutionRequest,
  ): boolean {
    const adapter = this.get(request.capability);

    if (!adapter) {
      return false;
    }

    if (adapter.status() !== "AVAILABLE") {
      return false;
    }

    return adapter.canExecute(request);
  }
}
