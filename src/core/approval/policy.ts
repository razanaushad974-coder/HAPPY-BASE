import type {
  ApprovalAction,
  ApprovalLevel,
} from "./types";

export interface ApprovalPolicyResult {
  required: boolean;
  level: ApprovalLevel;
  reason: string;
}

export class ApprovalPolicy {
  evaluate(
    risk: "LOW" | "MEDIUM" | "HIGH" | "CRITICAL",
    actions: ApprovalAction[],
  ): ApprovalPolicyResult {
    if (
      risk === "CRITICAL" ||
      actions.includes("SECURITY_CHANGE") ||
      actions.includes("PAYMENT")
    ) {
      return {
        required: true,
        level: "SECURITY",
        reason:
          "Critical, security, or payment changes require security-level approval.",
      };
    }

    if (
      actions.includes("DEPLOY") ||
      actions.includes("PUBLISH") ||
      actions.includes("DELETE")
    ) {
      return {
        required: true,
        level: "FOUNDER",
        reason:
          "Deployment, publishing, or deletion requires founder approval.",
      };
    }

    if (
      risk === "HIGH" ||
      actions.includes("DATA_CHANGE") ||
      actions.includes("AUTOMATE")
    ) {
      return {
        required: true,
        level: "FOUNDER",
        reason:
          "High-risk, data, or automation changes require founder approval.",
      };
    }

    if (risk === "MEDIUM") {
      return {
        required: true,
        level: "ADMIN",
        reason:
          "Medium-risk changes require administrative approval.",
      };
    }

    return {
      required: false,
      level: "NONE",
      reason:
        "Low-risk change does not require an approval gate.",
    };
  }
}
