/**
 * HAPPY Context Engine
 *
 * Context gives a command the information required to
 * understand references such as:
 *
 * "isko update karo"
 * "ye wala publish karo"
 * "meri website check karo"
 * "continue that mission"
 *
 * Context resolution must never invent missing facts.
 */

export type ContextSource =
  | "USER"
  | "SESSION"
  | "PROJECT"
  | "MISSION"
  | "TASK"
  | "CONVERSATION"
  | "MEMORY"
  | "SYSTEM";

export type ContextConfidence =
  | "HIGH"
  | "MEDIUM"
  | "LOW"
  | "UNKNOWN";

export interface ContextItem<T = unknown> {
  key: string;
  value: T;
  source: ContextSource;
  confidence: ContextConfidence;
  updatedAt: string;
}

export interface HappyContext {
  userId?: string;
  workspaceId?: string;

  activeProject?: ContextItem<string>;
  activeMission?: ContextItem<string>;
  activeTask?: ContextItem<string>;

  recentCommand?: ContextItem<string>;

  language?: ContextItem<string>;

  referencedEntities: ContextItem<string>[];

  collectedAt: string;
}

export interface ResolvedReference {
  token: string;

  entityType:
    | "PROJECT"
    | "MISSION"
    | "TASK"
    | "FILE";

  entityId: string;

  confidence: ContextConfidence;

  source:
    | "ACTIVE_CONTEXT"
    | "PERSISTED_MEMORY";
}

export interface ContextResolution {
  context: HappyContext;

  unresolvedReferences: string[];

  resolvedReferences:
    ResolvedReference[];

  requiresClarification:
    boolean;
}
