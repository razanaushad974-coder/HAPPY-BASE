export type ApprovalLevel =
  | "NONE"
  | "FOUNDER"
  | "ADMIN"
  | "SECURITY"
  | "MULTI_APPROVER";

export type ApprovalStatus =
  | "PENDING"
  | "APPROVED"
  | "REJECTED"
  | "EXPIRED"
  | "CANCELLED";

export type ApprovalAction =
  | "CREATE"
  | "MODIFY"
  | "DELETE"
  | "RENAME"
  | "DEPLOY"
  | "PUBLISH"
  | "AUTOMATE"
  | "PAYMENT"
  | "SECURITY_CHANGE"
  | "DATA_CHANGE";

export interface ApprovalRequest {
  id: string;
  buildPlanId: string;
  requestedBy: string;
  level: ApprovalLevel;
  actions: ApprovalAction[];
  reason: string;
  status: ApprovalStatus;
  createdAt: string;
  expiresAt?: string;
}

export interface ApprovalDecision {
  id: string;
  requestId: string;
  approverId: string;
  status: "APPROVED" | "REJECTED";
  reason: string;
  decidedAt: string;
}
