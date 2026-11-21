import type { ExecutionStatus } from "../execution/types";
import type { Mission, MissionTask } from "./types";

export type MissionRecoveryDisposition =
  | "NO_RECOVERY_REQUIRED"
  | "RECONCILIATION_REQUIRED"
  | "EXECUTION_OUTCOME_UNKNOWN"
  | "VERIFICATION_RESUME_REQUIRED"
  | "APPROVAL_REVIEW_REQUIRED"
  | "FAILED_EXECUTION_REVIEW_REQUIRED"
  | "BLOCKED_REVIEW_REQUIRED";

export type MissionRecoveryReason =
  | "TASK_NOT_ACTIVE"
  | "EXECUTION_RECORD_MISSING"
  | "MULTIPLE_EXECUTION_RECORDS"
  | "EXECUTION_STATE_UNCONFIRMED"
  | "EXECUTION_STILL_RUNNING"
  | "EXECUTION_COMPLETED"
  | "EXECUTION_FAILED"
  | "EXECUTION_WAITING_APPROVAL"
  | "EXECUTION_NOT_CONNECTED"
  | "EXECUTION_BLOCKED"
  | "EXECUTION_CANCELLED";

export interface MissionRecoveryExecution {
  id: string;
  missionId: string;
  taskId: string;
  status?: ExecutionStatus;
}

export interface MissionTaskRecoveryAssessment {
  missionId: string;
  taskId: string;
  disposition: MissionRecoveryDisposition;
  reason: MissionRecoveryReason;
  executionId?: string;
}

/**
 * Read-only crash-recovery assessment. It deliberately never retries or
 * dispatches work: an absent/ambiguous/incomplete execution record cannot
 * prove that an external side effect did not occur.
 */
export function assessMissionRecovery(
  mission: Mission,
  tasks: MissionTask[],
  executions: MissionRecoveryExecution[],
): MissionTaskRecoveryAssessment[] {
  const declared = new Set(mission.taskIds);
  if (
    declared.size !== mission.taskIds.length ||
    tasks.length !== declared.size ||
    tasks.some((task) => task.missionId !== mission.id || !declared.has(task.id)) ||
    new Set(tasks.map((task) => task.id)).size !== tasks.length
  ) {
    throw new Error("Mission recovery requires an exact mission task snapshot.");
  }

  const taskIds = new Set(tasks.map((task) => task.id));
  if (executions.some((execution) =>
    execution.missionId !== mission.id || !taskIds.has(execution.taskId)
  )) {
    throw new Error("Mission recovery received an execution outside the mission snapshot.");
  }

  return tasks.map((task) => {
    if (task.status !== "RUNNING" && task.status !== "VERIFYING") {
      return {
        missionId: mission.id,
        taskId: task.id,
        disposition: "NO_RECOVERY_REQUIRED" as const,
        reason: "TASK_NOT_ACTIVE" as const,
      };
    }

    const matches = executions.filter((execution) =>
      execution.missionId === mission.id && execution.taskId === task.id
    );
    if (matches.length === 0) {
      return {
        missionId: mission.id,
        taskId: task.id,
        disposition: "RECONCILIATION_REQUIRED" as const,
        reason: "EXECUTION_RECORD_MISSING" as const,
      };
    }
    if (matches.length !== 1) {
      return {
        missionId: mission.id,
        taskId: task.id,
        disposition: "RECONCILIATION_REQUIRED" as const,
        reason: "MULTIPLE_EXECUTION_RECORDS" as const,
      };
    }

    const execution = matches[0];
    const base = { missionId: mission.id, taskId: task.id, executionId: execution.id };
    switch (execution.status) {
      case "COMPLETED":
        return { ...base, disposition: "VERIFICATION_RESUME_REQUIRED" as const, reason: "EXECUTION_COMPLETED" as const };
      case "RUNNING":
        return { ...base, disposition: "EXECUTION_OUTCOME_UNKNOWN" as const, reason: "EXECUTION_STILL_RUNNING" as const };
      case "RECEIVED":
      case "READY":
      case undefined:
        return { ...base, disposition: "RECONCILIATION_REQUIRED" as const, reason: "EXECUTION_STATE_UNCONFIRMED" as const };
      case "WAITING_APPROVAL":
        return { ...base, disposition: "APPROVAL_REVIEW_REQUIRED" as const, reason: "EXECUTION_WAITING_APPROVAL" as const };
      case "FAILED":
        return { ...base, disposition: "FAILED_EXECUTION_REVIEW_REQUIRED" as const, reason: "EXECUTION_FAILED" as const };
      case "CANCELLED":
        return { ...base, disposition: "BLOCKED_REVIEW_REQUIRED" as const, reason: "EXECUTION_CANCELLED" as const };
      case "BLOCKED":
      case "NOT_YET_CONNECTED":
        return { ...base, disposition: "BLOCKED_REVIEW_REQUIRED" as const, reason: execution.status === "BLOCKED" ? "EXECUTION_BLOCKED" as const : "EXECUTION_NOT_CONNECTED" as const };
    }
  });
}
