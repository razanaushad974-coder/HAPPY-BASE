import type {
  ApprovalRequest,
} from "../approval/types";
import type {
  ControlledChangeSet,
} from "../change-control/change-control";

export interface GateResult {
  allowed: boolean;
  reason: string;
}

export class ApprovalGate {
  evaluate(
    changeSet: ControlledChangeSet,
    approval?: ApprovalRequest,
  ): GateResult {
    if (changeSet.status !== "READY") {
      return {
        allowed: false,
        reason:
          "Change set is not ready for execution.",
      };
    }

    if (!changeSet.approvalRequestId) {
      if (approval) {
        return {
          allowed: false,
          reason:
            "Unexpected approval was supplied for a change set without a linked approval request.",
        };
      }

      return {
        allowed: true,
        reason:
          "Change set is ready and does not require approval.",
      };
    }

    if (!approval) {
      return {
        allowed: false,
        reason:
          "Required approval is missing.",
      };
    }

    if (
      approval.id !==
      changeSet.approvalRequestId
    ) {
      return {
        allowed: false,
        reason:
          "Approval does not match the change set.",
      };
    }

    if (approval.status !== "APPROVED") {
      return {
        allowed: false,
        reason:
          "Approval has not been granted.",
      };
    }

    return {
      allowed: true,
      reason:
        "Valid linked approval is present.",
    };
  }
}
