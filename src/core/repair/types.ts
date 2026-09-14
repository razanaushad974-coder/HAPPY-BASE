export type FailureCategory =
  | "TYPE_ERROR"
  | "TEST_FAILURE"
  | "BUILD_FAILURE"
  | "SECURITY_FAILURE"
  | "TIMEOUT"
  | "UNKNOWN";

export type RepairStatus =
  | "DETECTED"
  | "ANALYZING"
  | "PROPOSED"
  | "WAITING_APPROVAL"
  | "APPLIED"
  | "RETESTING"
  | "RESOLVED"
  | "FAILED"
  | "BLOCKED";

export interface FailureReport {
  id: string;
  buildPlanId: string;
  testId?: string;
  category: FailureCategory;
  message: string;
  stderr: string;
  exitCode: number | null;
  detectedAt: string;
}

export interface RepairAction {
  id: string;
  failureId: string;
  path: string;
  description: string;
  proposedContent?: string;
  requiresApproval: boolean;
}

export interface RepairPlan {
  id: string;
  buildPlanId: string;
  failureId: string;
  diagnosis: string;
  actions: RepairAction[];
  status: RepairStatus;
  requiresApproval: boolean;
  createdAt: string;
}
