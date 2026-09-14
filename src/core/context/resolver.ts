import type {
  ContextItem,
  HappyContext,
  ContextResolution,
  ResolvedReference,
} from "./types";

function now(): string {
  return new Date().toISOString();
}

function item<T>(
  key: string,
  value: T,
  source: ContextItem<T>["source"],
  confidence: ContextItem<T>["confidence"],
): ContextItem<T> {
  return {
    key,
    value,
    source,
    confidence,
    updatedAt: now(),
  };
}

export interface ContextInput {
  userId?: string;
  workspaceId?: string;
  activeProjectId?: string;
  activeMissionId?: string;
  activeTaskId?: string;
  recentCommand?: string;
  language?: string;
  memorySummary?: string;
}

export function buildContext(
  input: ContextInput,
): HappyContext {
  return {
    userId: input.userId,
    workspaceId: input.workspaceId,

    activeProject: input.activeProjectId
      ? item(
          "activeProject",
          input.activeProjectId,
          "PROJECT",
          "HIGH",
        )
      : undefined,

    activeMission: input.activeMissionId
      ? item(
          "activeMission",
          input.activeMissionId,
          "MISSION",
          "HIGH",
        )
      : undefined,

    activeTask: input.activeTaskId
      ? item(
          "activeTask",
          input.activeTaskId,
          "TASK",
          "HIGH",
        )
      : undefined,

    recentCommand: input.recentCommand
      ? item(
          "recentCommand",
          input.recentCommand,
          "CONVERSATION",
          "HIGH",
        )
      : undefined,

    language: input.language
      ? item(
          "language",
          input.language,
          "USER",
          "HIGH",
        )
      : undefined,

    referencedEntities: input.memorySummary
      ? [
          item(
            "persistentMemory",
            input.memorySummary,
            "MEMORY",
            "HIGH",
          ),
        ]
      : [],

    collectedAt: now(),
  };
}

export function resolveContext(
  input: ContextInput,
  command: string,
): ContextResolution {
  const context = buildContext(input);
  const unresolvedReferences: string[] = [];
  const resolvedReferences: ResolvedReference[] = [];

  const text =
    command
      .trim()
      .toLowerCase();

  /*
   * Deterministic reference resolver.
   *
   * Resolution order:
   *
   * 1. Explicit entity phrase:
   *    "that mission"
   *    "this project"
   *    "that task"
   *
   * 2. Generic references:
   *    "isko"
   *    "usko"
   *    "ye wala"
   *    "yeh wala"
   *    "this"
   *    "that"
   *    "it"
   *
   * Generic references resolve only when exactly one
   * appropriate active entity exists.
   *
   * HAPPY must never guess between multiple candidates.
   */

  const resolveEntity =
    (
      token: string,
      entityType:
        | "PROJECT"
        | "MISSION"
        | "TASK",
      contextItem:
        | ContextItem<string>
        | undefined,
      source:
        | "ACTIVE_CONTEXT"
        | "PERSISTED_MEMORY",
    ): boolean => {
      if (!contextItem?.value) {
        return false;
      }

      resolvedReferences.push({
        token,
        entityType,
        entityId:
          contextItem.value,
        confidence:
          contextItem.confidence,
        source,
      });

      return true;
    };

  const resolveExplicit =
    (
      token: string,
      entityType:
        | "PROJECT"
        | "MISSION"
        | "TASK",
      contextItem:
        | ContextItem<string>
        | undefined,
    ): boolean =>
      resolveEntity(
        token,
        entityType,
        contextItem,
        "ACTIVE_CONTEXT",
      );

  const has =
    (value: string): boolean =>
      text.includes(value);

  /*
   * Explicit references first.
   */

  if (
    has("that mission") ||
    has("this mission")
  ) {
    if (
      !resolveExplicit(
        has("that mission")
          ? "that mission"
          : "this mission",
        "MISSION",
        context.activeMission,
      )
    ) {
      unresolvedReferences.push(
        has("that mission")
          ? "that mission"
          : "this mission",
      );
    }
  }

  if (
    has("that project") ||
    has("this project")
  ) {
    if (
      !resolveExplicit(
        has("that project")
          ? "that project"
          : "this project",
        "PROJECT",
        context.activeProject,
      )
    ) {
      unresolvedReferences.push(
        has("that project")
          ? "that project"
          : "this project",
      );
    }
  }

  if (
    has("that task") ||
    has("this task")
  ) {
    if (
      !resolveExplicit(
        has("that task")
          ? "that task"
          : "this task",
        "TASK",
        context.activeTask,
      )
    ) {
      unresolvedReferences.push(
        has("that task")
          ? "that task"
          : "this task",
      );
    }
  }

  /*
   * Generic references.
   */

  const genericReferences = [
    "isko",
    "usko",
    "ye wala",
    "yeh wala",
    "that one",
    "this one",
    "that",
    "this",
    "it",
  ];

  /*
   * Explicit entity references have already been resolved above.
   *
   * Do not let the generic token detector see the
   * "this"/"that" portion of phrases such as:
   *
   *   "this project"
   *   "that mission"
   *   "this task"
   *
   * Otherwise the generic detector incorrectly adds
   * "ambiguous_entity" even after the explicit reference
   * was successfully resolved.
   */
  const genericDetectionText =
    text.replace(
      /\b(?:that|this)\s+(?:mission|project|task)\b/gi,
      " ",
    );

  const containsGenericReference =
    genericReferences.some(
      (reference) => {
        const escaped =
          reference.replace(
            /[.*+?^${}()|[\]\\]/g,
            "\\$&",
          );

        return new RegExp(
          `(^|\\s)${escaped}(?=\\s|$|[,.!?])`,
          "i",
        ).test(
          genericDetectionText,
        );
      },
    );

  if (containsGenericReference) {
    const candidates = [
      context.activeTask
        ? {
            entityType:
              "TASK" as const,
            item:
              context.activeTask,
          }
        : undefined,

      context.activeMission
        ? {
            entityType:
              "MISSION" as const,
            item:
              context.activeMission,
          }
        : undefined,

      context.activeProject
        ? {
            entityType:
              "PROJECT" as const,
            item:
              context.activeProject,
          }
        : undefined,
    ].filter(
      (
        candidate,
      ): candidate is {
        entityType:
          | "TASK"
          | "MISSION"
          | "PROJECT";
        item: ContextItem<string>;
      } =>
        candidate !==
        undefined,
    );

    if (candidates.length === 1) {
      const candidate =
        candidates[0];

      resolveEntity(
        "generic-reference",
        candidate.entityType,
        candidate.item,
        "ACTIVE_CONTEXT",
      );
    }
    else if (
      candidates.length === 0
    ) {
      unresolvedReferences.push(
        "referenced_entity",
      );
    }
    else {
      unresolvedReferences.push(
        "ambiguous_entity",
      );
    }
  }

  return {
    context,
    unresolvedReferences,
    resolvedReferences,
    requiresClarification:
      unresolvedReferences.length > 0,
  };
}


