import type {
  BuildFileChange,
  BuildPlan,
} from "../build/types";
import type {
  ApprovalRequest,
} from "../approval/types";

export type ChangeControlStatus =
  | "LOCKED"
  | "APPROVED"
  | "REJECTED"
  | "READY"
  | "APPLIED";

export interface ControlledChangeSet {
  id: string;
  buildPlanId: string;
  changes: BuildFileChange[];
  approvalRequestId?: string;
  status: ChangeControlStatus;
  createdAt: string;
}

export class ChangeControl {
  create(
    plan: BuildPlan,
    approvalRequest?: ApprovalRequest,
  ): ControlledChangeSet {
    const needsApproval =
      plan.requiresApproval;

    if (
      needsApproval &&
      !approvalRequest
    ) {
      return {
        id: `changeset_${crypto.randomUUID()}`,
        buildPlanId: plan.id,
        changes: [...plan.fileChanges],
        status: "LOCKED",
        createdAt:
          new Date().toISOString(),
      };
    }

    return {
      id: `changeset_${crypto.randomUUID()}`,
      buildPlanId: plan.id,
      changes: [...plan.fileChanges],
      approvalRequestId:
        approvalRequest?.id,
      status:
        approvalRequest?.status ===
        "APPROVED"
          ? "APPROVED"
          : needsApproval
            ? "LOCKED"
            : "READY",
      createdAt:
        new Date().toISOString(),
    };
  }

  authorize(
    changeSet: ControlledChangeSet,
    approval: ApprovalRequest,
  ): ControlledChangeSet {
    if (
      approval.id !==
      changeSet.approvalRequestId
    ) {
      throw new Error(
        "Approval does not belong to this change set.",
      );
    }

    if (
      approval.status !==
      "APPROVED"
    ) {
      throw new Error(
        "Change set cannot be authorized without approval.",
      );
    }

    return {
      ...changeSet,
      status: "APPROVED",
    };
  }

  markReady(
    changeSet: ControlledChangeSet,
  ): ControlledChangeSet {
    if (
      changeSet.status !==
      "APPROVED" &&
      changeSet.status !==
      "READY"
    ) {
      throw new Error(
        "Change set is not authorized.",
      );
    }

    return {
      ...changeSet,
      status: "READY",
    };
  }
}
