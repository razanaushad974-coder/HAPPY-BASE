import {
  ContractExecutionAdapter,
} from "./contract-adapter";

import {
  ExecutionAdapterRegistry,
} from "./registry";

const capabilities = [
  "CODE",
  "FILE",
  "API",
  "BROWSER",
  "SHELL",
  "DATABASE",
  "AI",
  "DEPLOYMENT",
  "PUBLISH",
  "AUTOMATION",
] as const;

export function createDefaultExecutionRegistry(): ExecutionAdapterRegistry {
  const registry = new ExecutionAdapterRegistry();

  for (const capability of capabilities) {
    registry.register(
      new ContractExecutionAdapter(
        capability,
        "NOT_YET_CONNECTED",
      ),
    );
  }

  return registry;
}
