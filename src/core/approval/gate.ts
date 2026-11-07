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
    if (changeSet.status === "READY") {
      if (changeSet.approvalRequestId) {
        if (!approval) {
          return {
            allowed: false,
            reason: "Linked approval is required for this ready change set.",
          };
        }

        if (approval.id !== changeSet.approvalRequestId) {
          return {
            allowed: false,
            reason: "Approval does not match the ready change set.",
          };
        }

        if (approval.status !== "APPROVED") {
          return {
            allowed: false,
            reason: "Linked approval has not been granted.",
          };
        }
      }

      return {
        allowed: true,
        reason: "Change set is ready for execution.",
      };
    }

    if (
      !approval
    ) {
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

    if (
      approval.status !==
      "APPROVED"
    ) {
      return {
        allowed: false,
        reason:
          "Approval has not been granted.",
      };
    }

    return {
      allowed: true,
      reason:
        "Valid approval is present.",
    };
  }
}
