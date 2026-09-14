import type { FounderCommand } from "../founder/types";
import type { KnowledgeSource } from "./types";

export interface FounderBuildContext {
  command: FounderCommand;

  knowledgeSources: KnowledgeSource[];

  referencedFiles: string[];

  requirements: string[];

  constraints: string[];

  unresolvedQuestions: string[];
}

export function createFounderBuildContext(
  command: FounderCommand,
  knowledgeSources: KnowledgeSource[] = [],
): FounderBuildContext {
  return {
    command,
    knowledgeSources,
    referencedFiles: [],
    requirements: [],
    constraints: [],
    unresolvedQuestions: [],
  };
}
