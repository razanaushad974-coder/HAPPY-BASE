/**
 * HAPPY Founder Command Contract
 *
 * Founder OS is the privileged control plane.
 *
 * A command can request analysis, planning, building,
 * modifying, researching, testing, deployment, etc.
 *
 * This contract does NOT execute anything.
 * Execution belongs to later controlled layers.
 */

export type FounderCommandMode =
  | "ASK"
  | "UNDERSTAND"
  | "PLAN"
  | "BUILD"
  | "MODIFY"
  | "RESEARCH"
  | "TEST"
  | "VERIFY"
  | "DEPLOY"
  | "PUBLISH"
  | "AUTOMATE"
  | "CONTROL";

export type FounderCommandStatus =
  | "RECEIVED"
  | "UNDERSTANDING"
  | "PLANNED"
  | "WAITING_APPROVAL"
  | "EXECUTING"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "BLOCKED"
  | "NOT_YET_CONNECTED";

export interface FounderCommand {
  id: string;

  rawText: string;

  normalizedText: string;

  mode: FounderCommandMode;

  status: FounderCommandStatus;

  createdAt: string;

  createdBy: "FOUNDER";

  requiresApproval: boolean;

  metadata?: Record<string, string>;
}

export interface FounderCommandResult {
  commandId: string;

  success: boolean;

  status: FounderCommandStatus;

  message: string;

  nextAction?: string;
}
