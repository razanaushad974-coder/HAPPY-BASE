export type BuildAction =
  | "CREATE"
  | "MODIFY"
  | "DELETE"
  | "RENAME";

export type BuildRisk =
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "CRITICAL";

export type BuildStatus =
  | "DRAFT"
  | "PLANNED"
  | "WAITING_APPROVAL"
  | "APPROVED"
  | "EXECUTING"
  | "TESTING"
  | "VERIFYING"
  | "COMPLETED"
  | "FAILED"
  | "BLOCKED"
  | "NOT_YET_CONNECTED";

export type TestType =
  | "TYPECHECK"
  | "UNIT"
  | "INTEGRATION"
  | "E2E"
  | "BUILD"
  | "SECURITY";

export interface BuildFileChange {
  id: string;
  action: BuildAction;
  path: string;
  description: string;
  content?: string;
  previousContentHash?: string;
  risk: BuildRisk;
  requiresApproval: boolean;
}

export interface BuildTestPlan {
  id: string;
  type: TestType;
  command: string;
  description: string;
  required: boolean;
}

export interface BuildPlan {
  id: string;
  commandId: string;
  title: string;
  objective: string;
  requirements: string[];
  constraints: string[];
  fileChanges: BuildFileChange[];
  tests: BuildTestPlan[];
  risk: BuildRisk;
  status: BuildStatus;
  requiresApproval: boolean;
  createdAt: string;
}

export interface BuildRequest {
  id: string;
  commandId: string;
  objective: string;
  requirements: string[];
  constraints: string[];
  referencedFiles: string[];
  createdAt: string;
}

export interface BuildResult {
  buildPlanId: string;
  status: BuildStatus;
  changedFiles: string[];
  testsRun: string[];
  errors: string[];
  verificationRequired: boolean;
  executionProvider:
    | "LOCAL_WORKSPACE"
    | "SANDBOX"
    | "NOT_YET_CONNECTED";
}
