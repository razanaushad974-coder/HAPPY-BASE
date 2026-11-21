import type { ExecutionRequest } from "../execution/types";
import type { TenantScope } from "../state/types";

export interface MissionTaskLease {
  id: string;
  scope: TenantScope & { userId: string };
  missionId: string;
  taskId: string;
  ownerId: string;
  attempt: number;
  fencingToken: number;
  expiresAt: string;
}

export interface ExecutionDispatchIntent {
  id: string;
  idempotencyKey: string;
  payloadDigest: string;
  scope: TenantScope & { userId: string };
  missionId: string;
  taskId: string;
  attempt: number;
  capability: ExecutionRequest["capability"];
  action: string;
  createdAt: string;
}

export type MissionLeaseContractErrorCode =
  | "INVALID_LEASE"
  | "LEASE_EXPIRED"
  | "LEASE_IDENTITY_MISMATCH"
  | "STALE_FENCING_TOKEN"
  | "DISPATCH_BINDING_MISMATCH"
  | "INVALID_DISPATCH_INTENT";

export class MissionLeaseContractError extends Error {
  constructor(readonly code: MissionLeaseContractErrorCode, message = code) {
    super(message);
    this.name = "MissionLeaseContractError";
  }
}

function assertCompleteScope(scope: TenantScope & { userId: string }): void {
  if (!scope.organizationId.trim() || !scope.workspaceId.trim() || !scope.userId.trim()) {
    throw new MissionLeaseContractError("INVALID_LEASE", "Complete tenant and principal scope is required.");
  }
}

function sameScope(left: TenantScope & { userId: string }, right: TenantScope & { userId: string }): boolean {
  return left.organizationId === right.organizationId && left.workspaceId === right.workspaceId && left.userId === right.userId;
}

function validateLease(lease: MissionTaskLease): void {
  assertCompleteScope(lease.scope);
  if (!lease.id.trim() || !lease.missionId.trim() || !lease.taskId.trim() || !lease.ownerId.trim() ||
      !Number.isSafeInteger(lease.attempt) || lease.attempt < 1 ||
      !Number.isSafeInteger(lease.fencingToken) || lease.fencingToken < 1 ||
      !Number.isFinite(Date.parse(lease.expiresAt))) {
    throw new MissionLeaseContractError("INVALID_LEASE", "Lease fields are incomplete or invalid.");
  }
}

/**
 * Pure lease check. Storage must read/lock or CAS the current lease row and
 * enforce its fencing token in the same transaction as the protected write.
 */
export function assertCurrentMissionTaskLease(current: MissionTaskLease, presented: MissionTaskLease, nowEpochMs: number): void {
  validateLease(current);
  validateLease(presented);
  if (!Number.isFinite(nowEpochMs)) throw new MissionLeaseContractError("INVALID_LEASE", "Finite current time is required.");
  if (current.fencingToken !== presented.fencingToken) {
    throw new MissionLeaseContractError("STALE_FENCING_TOKEN", "A newer fencing token superseded this worker.");
  }
  if (current.id !== presented.id || !sameScope(current.scope, presented.scope) ||
      current.missionId !== presented.missionId || current.taskId !== presented.taskId ||
      current.ownerId !== presented.ownerId || current.attempt !== presented.attempt ||
      current.expiresAt !== presented.expiresAt) {
    throw new MissionLeaseContractError("LEASE_IDENTITY_MISMATCH", "Presented lease differs from the current persisted lease.");
  }
  if (Date.parse(current.expiresAt) <= nowEpochMs) {
    throw new MissionLeaseContractError("LEASE_EXPIRED", "Expired task leases cannot authorize mutations.");
  }
}

/** Checks exact dispatch binding before an outbox insert; it does not deduplicate side effects. */
export function assertExecutionDispatchBinding(intent: ExecutionDispatchIntent, lease: MissionTaskLease, request: ExecutionRequest): void {
  validateLease(lease);
  assertCompleteScope(intent.scope);
  if (!intent.id.trim() || !intent.idempotencyKey.trim() || !intent.payloadDigest.trim() || !Number.isFinite(Date.parse(intent.createdAt))) {
    throw new MissionLeaseContractError("INVALID_DISPATCH_INTENT", "Dispatch intent identity, digest, or timestamp is invalid.");
  }
  if (!sameScope(intent.scope, lease.scope) || intent.missionId !== lease.missionId ||
      intent.taskId !== lease.taskId || intent.attempt !== lease.attempt ||
      intent.missionId !== request.missionId || intent.taskId !== request.taskId ||
      intent.capability !== request.capability || intent.action !== request.action) {
    throw new MissionLeaseContractError("DISPATCH_BINDING_MISMATCH", "Dispatch intent does not match its lease and execution request.");
  }
}