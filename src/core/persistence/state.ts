import type { EntityType, PersistedRecord } from "./types";

export interface HappyState {
  users: PersistedRecord<unknown>[];
  workspaces: PersistedRecord<unknown>[];
  projects: PersistedRecord<unknown>[];
  commands: PersistedRecord<unknown>[];
  missions: PersistedRecord<unknown>[];
  tasks: PersistedRecord<unknown>[];
  executions: PersistedRecord<unknown>[];
  verifications: PersistedRecord<unknown>[];
  evidence: PersistedRecord<unknown>[];
  memories: PersistedRecord<unknown>[];
  approvals: PersistedRecord<unknown>[];
  auditEvents: PersistedRecord<unknown>[];
}

export const ENTITY_STATE_KEYS: Record<
  EntityType,
  keyof HappyState
> = {
  USER: "users",
  WORKSPACE: "workspaces",
  PROJECT: "projects",
  COMMAND: "commands",
  MISSION: "missions",
  TASK: "tasks",
  EXECUTION: "executions",
  VERIFICATION: "verifications",
  EVIDENCE: "evidence",
  MEMORY: "memories",
  APPROVAL: "approvals",
  AUDIT_EVENT: "auditEvents",
};

export function createEmptyState(): HappyState {
  return {
    users: [],
    workspaces: [],
    projects: [],
    commands: [],
    missions: [],
    tasks: [],
    executions: [],
    verifications: [],
    evidence: [],
    memories: [],
    approvals: [],
    auditEvents: [],
  };
}
