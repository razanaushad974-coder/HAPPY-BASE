export type ExecutionCapability =
  | "CODE"
  | "FILE"
  | "API"
  | "BROWSER"
  | "SHELL"
  | "DATABASE"
  | "AI"
  | "DEPLOYMENT"
  | "PUBLISH"
  | "AUTOMATION";

export type AdapterStatus =
  | "AVAILABLE"
  | "NOT_YET_CONNECTED"
  | "DISABLED"
  | "ERROR";

export type ExecutionStatus =
  | "RECEIVED"
  | "WAITING_APPROVAL"
  | "READY"
  | "RUNNING"
  | "COMPLETED"
  | "FAILED"
  | "BLOCKED"
  | "NOT_YET_CONNECTED";

export type ExecutionRisk =
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "CRITICAL";

import type { ResolvedReference } from "../context/types";

export interface ExecutionRequest {
  id: string;
  taskId: string;
  missionId: string;
  capability: ExecutionCapability;
  action: string;
  input: unknown;
  targetReference?: ResolvedReference;
  requiresApproval: boolean;
  approved: boolean;
  risk: ExecutionRisk;
  createdAt: string;
}

export interface ExecutionResult {
  id: string;
  requestId: string;
  capability: ExecutionCapability;
  status: ExecutionStatus;
  output?: unknown;
  error?: string;
  evidenceIds: string[];
  startedAt: string;
  completedAt?: string;
}

export interface ExecutionAdapter {
  capability: ExecutionCapability;
  status(): AdapterStatus;
  canExecute(request: ExecutionRequest): boolean;
  execute(request: ExecutionRequest): Promise<ExecutionResult>;
}

