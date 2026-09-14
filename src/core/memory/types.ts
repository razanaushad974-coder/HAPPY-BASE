/**
 * HAPPY Memory Engine
 *
 * Memory is persistent knowledge that HAPPY is explicitly
 * allowed to retain and reuse.
 *
 * IMPORTANT:
 * Memory must never invent facts.
 */

export type MemoryType =
  | "FACT"
  | "PREFERENCE"
  | "EPISODIC"
  | "PROJECT"
  | "MISSION"
  | "TASK"
  | "DECISION"
  | "INSTRUCTION";

export type MemoryScope =
  | "USER"
  | "WORKSPACE"
  | "PROJECT"
  | "MISSION"
  | "TASK"
  | "SESSION";

export type MemoryConfidence =
  | "HIGH"
  | "MEDIUM"
  | "LOW";

export interface HappyMemory {
  id: string;

  type: MemoryType;
  scope: MemoryScope;

  userId?: string;
  workspaceId?: string;
  projectId?: string;
  missionId?: string;
  taskId?: string;

  key: string;
  value: string;

  confidence: MemoryConfidence;

  source: string;

  createdAt: string;
  updatedAt: string;

  expiresAt?: string;
}

export interface CreateMemoryInput {
  type: MemoryType;
  scope: MemoryScope;

  userId?: string;
  workspaceId?: string;
  projectId?: string;
  missionId?: string;
  taskId?: string;

  key: string;
  value: string;

  confidence?: MemoryConfidence;
  source: string;

  expiresAt?: string;
}

export interface MemoryQuery {
  userId?: string;
  workspaceId?: string;
  projectId?: string;
  missionId?: string;
  taskId?: string;

  type?: MemoryType;
  scope?: MemoryScope;

  key?: string;
  text?: string;

  limit?: number;
}
