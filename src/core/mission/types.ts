export type MissionStatus =
  | "DRAFT"
  | "PLANNED"
  | "WAITING_APPROVAL"
  | "READY"
  | "RUNNING"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "BLOCKED"
  | "CANCELLED";

export type TaskStatus =
  | "PENDING"
  | "BLOCKED"
  | "READY"
  | "RUNNING"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "CANCELLED";

export type TaskAction =
  | "UNDERSTAND"
  | "RESEARCH"
  | "CREATE"
  | "MODIFY"
  | "BUILD"
  | "TEST"
  | "VERIFY"
  | "DEPLOY"
  | "PUBLISH"
  | "AUTOMATE"
  | "CONTROL";

export interface Mission {
  id: string;
  goal: string;
  planId: string;
  status: MissionStatus;
  taskIds: string[];
  rootTaskIds: string[];
  completedTaskIds: string[];
  failedTaskIds: string[];
  blockedTaskIds: string[];
  progressPercent: number;
  createdAt: string;
  updatedAt: string;
}

export interface MissionTask {
  id: string;
  missionId: string;
  action: TaskAction;
  title: string;
  description: string;
  status: TaskStatus;
  dependencyIds: string[];
  dependentTaskIds: string[];
  order: number;
  retryCount: number;
  maxRetries: number;
  requiresApproval: boolean;
  verificationRequired: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface TaskGraph {
  missionId: string;
  tasks: MissionTask[];
  roots: string[];
  leaves: string[];
}

export interface MissionSnapshot {
  mission: Mission;
  graph: TaskGraph;
}
