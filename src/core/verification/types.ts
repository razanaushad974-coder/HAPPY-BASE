export type VerificationStatus =
  | "PENDING"
  | "VERIFYING"
  | "PASSED"
  | "FAILED"
  | "PARTIAL"
  | "BLOCKED"
  | "NOT_YET_CONNECTED";

export type VerificationMethod =
  | "ASSERTION"
  | "FILE"
  | "API"
  | "BROWSER"
  | "DATABASE"
  | "COMMAND"
  | "SCREENSHOT"
  | "LOG"
  | "TEST"
  | "HUMAN_APPROVAL"
  | "MULTI_SOURCE";

export type VerificationConfidence =
  | "HIGH"
  | "MEDIUM"
  | "LOW"
  | "UNKNOWN";

export interface VerificationCriterion {
  id: string;
  description: string;
  expected: string;
  required: boolean;
}

export interface VerificationRequest {
  id: string;
  missionId: string;
  taskId: string;
  executionRequestId?: string;
  description: string;
  criteria: VerificationCriterion[];
  preferredMethods: VerificationMethod[];
  requiresEvidence: boolean;
  createdAt: string;
}

export interface VerificationResult {
  id: string;
  requestId: string;
  status: VerificationStatus;
  confidence: VerificationConfidence;
  passedCriteria: string[];
  failedCriteria: string[];
  partialCriteria: string[];
  evidenceIds: string[];
  summary: string;
  failureReason?: string;
  verifiedAt: string;
}
