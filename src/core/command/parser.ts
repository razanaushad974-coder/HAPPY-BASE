import type {
  CommandMode,
  CommandParseResult,
  HappyCommand,
  CommandSource,
} from "./types";

function normalizeText(input: string): string {
  return input
    .trim()
    .replace(/\s+/g, " ");
}

function detectMode(input: string): CommandMode {
  const text = input.toLowerCase();

  if (
    text.includes("research") ||
    text.includes("find out") ||
    text.includes("search") ||
    text.includes("compare")
  ) {
    return "RESEARCH";
  }

  if (
    text.includes("create") ||
    text.includes("build") ||
    text.includes("make") ||
    text.includes("generate")
  ) {
    return "CREATE";
  }

  if (
    text.includes("change") ||
    text.includes("update") ||
    text.includes("edit") ||
    text.includes("modify")
  ) {
    return "MODIFY";
  }

  if (
    text.includes("automate") ||
    text.includes("every day") ||
    text.includes("every week") ||
    text.includes("schedule")
  ) {
    return "AUTOMATE";
  }

  if (
    text.includes("do ") ||
    text.includes("execute") ||
    text.includes("send") ||
    text.includes("publish") ||
    text.includes("delete")
  ) {
    return "EXECUTE";
  }

  if (
    text.endsWith("?") ||
    text.startsWith("what ") ||
    text.startsWith("why ") ||
    text.startsWith("how ")
  ) {
    return "ASK";
  }

  return "PLAN";
}

export function parseCommand(
  rawInput: string,
  source: CommandSource = "TEXT",
): CommandParseResult {
  const normalizedInput = normalizeText(rawInput);

  const command: HappyCommand = {
    id: crypto.randomUUID(),
    rawInput,
    normalizedInput,
    source,
    mode: detectMode(normalizedInput),
    createdAt: new Date().toISOString(),
  };

  const requiresClarification = normalizedInput.length === 0;

  return {
    command,
    confidence: requiresClarification ? 0 : 0.85,
    requiresClarification,
    clarificationReason: requiresClarification
      ? "The command is empty."
      : undefined,
  };
}
