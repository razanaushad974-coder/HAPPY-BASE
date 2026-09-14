export type ReasoningMode =
  | "UNDERSTAND"
  | "ANALYZE"
  | "REASON"
  | "PLAN"
  | "DECOMPOSE"
  | "DECIDE"
  | "VERIFY";

export type ReasoningStatus =
  | "RECEIVED"
  | "ANALYZING"
  | "PLANNED"
  | "NEEDS_CLARIFICATION"
  | "WAITING_APPROVAL"
  | "READY"
  | "BLOCKED"
  | "FAILED";

export type PlanRisk =
  | "LOW"
  | "MEDIUM"
  | "HIGH"
  | "CRITICAL";

export type PlanStepAction =
  | "UNDERSTAND"
  | "RESEARCH"
  | "CREATE"
  | "MODIFY"
  | "BUILD"
  | "TEST"
  | "VERIFY"
  | "DEPLOY"
  | "PUBLISH"
  | "AUTOMATE"
  | "CONTROL";

import type { ResolvedReference } from "../context/types";

export interface ReasoningRequest {
  id: string;
  mode: ReasoningMode;
  goal: string;
  contextSummary: string;
  resolvedReferences: ResolvedReference[];
  constraints: string[];
  knownFacts: string[];
  assumptions: string[];
  unresolvedQuestions: string[];
  requiredCapabilities: string[];
  requiredKnowledgeSources: string[];
  createdAt: string;
}

export interface PlanStep {
  id: string;
  order: number;
  action: PlanStepAction;
  title: string;
  description: string;
  targetReference?: ResolvedReference;
  dependencies: string[];
  requiresApproval: boolean;
  risk: PlanRisk;
  verificationRequired: boolean;
}

export interface ExecutionPlan {
  id: string;
  reasoningRequestId: string;
  goal: string;
  status: ReasoningStatus;
  risk: PlanRisk;
  resolvedReferences: ResolvedReference[];
  assumptions: string[];
  unresolvedQuestions: string[];
  requiredCapabilities: string[];
  steps: PlanStep[];
  expectedOutputs: string[];
  failureConditions: string[];
  verificationRequirements: string[];
  createdAt: string;
}



