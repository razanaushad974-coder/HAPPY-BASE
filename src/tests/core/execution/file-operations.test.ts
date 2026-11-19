import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";

import { join } from "node:path";
import { tmpdir } from "node:os";

import {
  FileExecutionAdapter,
} from "../../../core/execution/file-execution-adapter";

import {
  WorkspaceCodeExecutor,
} from "../../../core/execution/workspace-code-executor";

import type {
  ResolvedReference,
} from "../../../core/context/types";
import type {
  ExecutionRequest,
} from "../../../core/execution/types";

function assert(
  condition: boolean,
  message: string,
): void {
  if (!condition) {
    throw new Error(message);
  }
}

function request(
  action: string,
  targetReference: ResolvedReference,
  input: unknown,
  overrides: Record<string, unknown> = {},
): ExecutionRequest {
  return {
    id: `file-op-${action.toLowerCase()}`,
    taskId: "task-file-ops",
    missionId: "mission-file-ops",
    capability: "FILE",
    action,
    input,
    targetReference,
    requiresApproval: false,
    approved: true,
    risk: "LOW",
    createdAt: new Date().toISOString(),
    ...overrides,
  };
}

async function main(): Promise<void> {
  const root =
    mkdtempSync(
      join(
        tmpdir(),
        "happy-file-ops-",
      ),
    );

  try {
    const executor =
      new WorkspaceCodeExecutor(root);

    const adapter =
      new FileExecutionAdapter(
        executor,
      );

    const target = {
      token: "file-ops",
      entityType: "FILE",
      entityId: "file-ops-001",
      confidence:¶»§q«^