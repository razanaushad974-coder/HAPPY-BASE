export type SystemStatus =
  | "READY"
  | "RUNNING"
  | "WAITING_APPROVAL"
  | "BLOCKED"
  | "FAILED"
  | "NOT_YET_CONNECTED";

export type ExecutionStatus =
  | "PENDING"
  | "RUNNING"
  | "SUCCEEDED"
  | "FAILED"
  | "CANCELLED"
  | "BLOCKED";

export type VerificationStatus =
  | "PENDING"
  | "VERIFIED"
  | "FAILED"
  | "NOT_VERIFIABLE";

export type ApprovalStatus =
  | "NOT_REQUIRED"
  | "PENDING"
  | "APPROVED"
  | "REJECTED";

export interface HappyOperationState {
  system: SystemStatus;
  execution: ExecutionStatus;
  verification: VerificationStatus;
  approval: ApprovalStatus;
}
