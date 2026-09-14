import type {
  FounderCommand,
  FounderCommandMode,
  FounderCommandResult,
} from "./types";

function createCommandId(): string {
  return `fcmd_${crypto.randomUUID()}`;
}

function detectMode(text: string): FounderCommandMode {
  const value = text.toLowerCase();

  if (
    value.includes("deploy") ||
    value.includes("production") ||
    value.includes("live")
  ) {
    return "DEPLOY";
  }

  if (
    value.includes("publish") ||
    value.includes("release")
  ) {
    return "PUBLISH";
  }

  if (
    value.includes("test") ||
    value.includes("testing")
  ) {
    return "TEST";
  }

  if (
    value.includes("verify") ||
    value.includes("check")
  ) {
    return "VERIFY";
  }

  if (
    value.includes("build") ||
    value.includes("create") ||
    value.includes("make") ||
    value.includes("bana")
  ) {
    return "BUILD";
  }

  if (
    value.includes("modify") ||
    value.includes("change") ||
    value.includes("edit") ||
    value.includes("update")
  ) {
    return "MODIFY";
  }

  if (
    value.includes("research") ||
    value.includes("find") ||
    value.includes("analyze") ||
    value.includes("analyse")
  ) {
    return "RESEARCH";
  }

  if (
    value.includes("automate") ||
    value.includes("automation")
  ) {
    return "AUTOMATE";
  }

  if (
    value.includes("plan") ||
    value.includes("roadmap")
  ) {
    return "PLAN";
  }

  if (
    value.includes("understand") ||
    value.includes("samajh")
  ) {
    return "UNDERSTAND";
  }

  if (
    value.includes("control") ||
    value.includes("manage")
  ) {
    return "CONTROL";
  }

  return "ASK";
}

export class FounderCommandEngine {
  create(rawText: string): FounderCommand {
    const normalizedText = rawText.trim();

    if (!normalizedText) {
      throw new Error("Founder command cannot be empty.");
    }

    const mode = detectMode(normalizedText);

    return {
      id: createCommandId(),
      rawText,
      normalizedText,
      mode,
      status: "RECEIVED",
      createdAt: new Date().toISOString(),
      createdBy: "FOUNDER",
      requiresApproval:
        mode === "DEPLOY" ||
        mode === "PUBLISH" ||
        mode === "MODIFY" ||
        mode === "AUTOMATE",
    };
  }

  acknowledge(command: FounderCommand): FounderCommandResult {
    return {
      commandId: command.id,
      success: true,
      status: "RECEIVED",
      message: "Founder command received by HAPPY.",
      nextAction: "UNDERSTAND",
    };
  }
}
