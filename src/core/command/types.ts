/**
 * HAPPY Command Engine
 *
 * A command is the normalized representation of what
 * the human asked HAPPY to understand and eventually do.
 *
 * IMPORTANT:
 * Parsing a command does NOT execute anything.
 * Execution happens later through the Mission/Execution layer.
 */

export type CommandSource =
  | "TEXT"
  | "VOICE"
  | "SYSTEM"
  | "API"
  | "AUTOMATION";

export type CommandMode =
  | "ASK"
  | "PLAN"
  | "EXECUTE"
  | "CREATE"
  | "MODIFY"
  | "RESEARCH"
  | "AUTOMATE"
  | "CONTROL";

export interface HappyCommand {
  id: string;
  rawInput: string;
  normalizedInput: string;
  source: CommandSource;
  mode: CommandMode;
  createdAt: string;
}

export interface CommandParseResult {
  command: HappyCommand;
  confidence: number;
  requiresClarification: boolean;
  clarificationReason?: string;
}
