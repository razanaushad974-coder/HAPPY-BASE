import {
  ApprovalPolicy,
} from "./policy";
import type {
  ApprovalAction,
  ApprovalDecision,
  ApprovalRequest,
} from "./types";

export class ApprovalEngine {
  private readonly policy =
    new ApprovalPolicy();

  createRequest(
    buildPlanId: string,
    requestedBy: string,
    risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
    actions: ApprovalAction[],
    reason: string,
  ): ApprovalRequest {
    const policy =
      this.policy.evaluate(
        risk,
        actions,
      );

    return {
      id: `approval_${crypto.randomUUID()}`,
      buildPlanId,
      requestedBy,
      level: policy.level,
      actions: [...actions],
      reason:
        `${reason} ${policy.reason}`,
      status: policy.required
        ? "PENDING"
        : "APPROVED",
      createdAt:
        new Date().toISOString(),
    };
  }

  decide(
    request: ApprovalRequest,
    approverId: string,
    approved: boolean,
    reason: string,
  ): {
    request: ApprovalRequest;
    decision: ApprovalDecision;
  } {
    if (
      request.status !== "PENDING"
    ) {
      throw new Error(
        "Approval request is not pending.",
      );
    }

    if (
      !approverId.trim()
    ) {
      throw new Error(
        "Approver identity is required.",
      );
    }

    const status =
      approved
        ? "APPROVED"
        : "REJECTED";

    return {
      request: {
        ...request,
        status,
      },
      decision: {
        id: `decision_${crypto.randomUUID()}`,
        requestId: request.id,
        approverId,
        status,
        reason,
        decidedAt:
          new Date().toISOString(),
      },
    };
  }
}
