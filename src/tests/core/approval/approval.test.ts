import {
  ApprovalEngine,
} from "@/core/approval/engine";
import {
  ApprovalGate,
} from "@/core/approval/gate";
import {
  ChangeControl,
} from "@/core/change-control/change-control";
import {
  AuditTrail,
} from "@/core/change-control/audit";
import type {
  BuildPlan,
} from "@/core/build/types";

function main(): void {
  const plan: BuildPlan = {
    id: "plan_step12",
    commandId: "command_step12",
    title:
      "Approval control test",
    objective:
      "Verify approval gates and controlled changes.",
    requirements: [
      "Founder approval is required.",
    ],
    constraints: [
      "No unauthorized changes.",
    ],
    fileChanges: [
      {
        id: "change_1",
        action: "MODIFY",
        path:
          "src/example.ts",
        risk: "HIGH",
        description: "Controlled test change.",
        requiresApproval: true,
      },
    ],
    tests: [],
    risk: "HIGH",
    status: "WAITING_APPROVAL",
    requiresApproval: true,
    createdAt:
      new Date().toISOString(),
  };

  const approvals =
    new ApprovalEngine();

  const request =
    approvals.createRequest(
      plan.id,
      "FOUNDER",
      plan.risk,
      ["MODIFY", "DEPLOY"],
      "HAPPY wants to apply a high-risk build change.",
    );

  if (
    request.status !== "PENDING" ||
    request.level !== "FOUNDER"
  ) {
    throw new Error(
      "Founder approval was not required.",
    );
  }

  const control =
    new ChangeControl();

  const locked =
    control.create(
      plan,
    );

  if (
    locked.status !== "LOCKED"
  ) {
    throw new Error(
      "Unauthorized change was not locked.",
    );
  }

  const blockedGate =
    new ApprovalGate().evaluate(
      locked,
    );

  if (
    blockedGate.allowed
  ) {
    throw new Error(
      "Locked change incorrectly passed the gate.",
    );
  }

  const decision =
    approvals.decide(
      request,
      "founder_001",
      true,
      "Approved after review.",
    );

  if (
    decision.request.status !==
    "APPROVED"
  ) {
    throw new Error(
      "Approval decision failed.",
    );
  }

  const authorized =
    control.authorize(
      {
        ...locked,
        approvalRequestId:
          decision.request.id,
      },
      decision.request,
    );

  const ready =
    control.markReady(
      authorized,
    );

  const allowedGate =
    new ApprovalGate().evaluate(
      ready,
      decision.request,
    );

  if (
    !allowedGate.allowed
  ) {
    throw new Error(
      "Approved change did not pass the execution gate.",
    );
  }

  const audit =
    new AuditTrail();

  const requested =
    audit.append(
      "APPROVAL_REQUESTED",
      "FOUNDER",
      request.id,
      "Approval requested.",
    );

  const approved =
    audit.append(
      "APPROVED",
      "founder_001",
      request.id,
      "Approval granted.",
    );

  const authorizedEvent =
    audit.append(
      "CHANGE_AUTHORIZED",
      "founder_001",
      ready.id,
      "Change set authorized.",
    );

  if (
    audit.list().length !== 3 ||
    !requested.id ||
    !approved.id ||
    !authorizedEvent.id
  ) {
    throw new Error(
      "Audit trail failed.",
    );
  }

  console.log(
    "Approval/change-control test: PASS",
  );

  console.log({
    approvalLevel:
      request.level,
    initialStatus:
      request.status,
    unauthorizedBlocked:
      !blockedGate.allowed,
    approvedStatus:
      decision.request.status,
    changeSetStatus:
      ready.status,
    executionAllowed:
      allowedGate.allowed,
    auditEvents:
      audit.list().length,
  });
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}

