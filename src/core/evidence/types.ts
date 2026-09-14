export type EvidenceType =
  | "TEXT"
  | "JSON"
  | "FILE"
  | "SCREENSHOT"
  | "VIDEO"
  | "AUDIO"
  | "API_RESPONSE"
  | "DATABASE_RESULT"
  | "COMMAND_OUTPUT"
  | "TEST_RESULT"
  | "LOG"
  | "HUMAN_CONFIRMATION";

export type EvidenceSource =
  | "EXECUTION"
  | "FILE"
  | "API"
  | "BROWSER"
  | "DATABASE"
  | "COMMAND"
  | "TEST"
  | "HUMAN"
  | "SYSTEM";

export interface Evidence {
  id: string;
  verificationRequestId: string;
  executionRequestId?: string;
  missionId: string;
  taskId: string;
  type: EvidenceType;
  source: EvidenceSource;
  title: string;
  content?: string;
  uri?: string;
  checksum?: string;
  metadata?: Record<string, unknown>;
  capturedAt: string;
  isPrimary: boolean;
}

export interface EvidenceInput {
  verificationRequestId: string;
  executionRequestId?: string;
  missionId: string;
  taskId: string;
  type: EvidenceType;
  source: EvidenceSource;
  title: string;
  content?: string;
  uri?: string;
  checksum?: string;
  metadata?: Record<string, unknown>;
  isPrimary?: boolean;
}
