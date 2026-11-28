import { createHash } from "node:crypto";
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
  executionRequestId: string;
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
  constructor(readonly code: MissionLeaseContractErrorCode, message: string = code) {
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

function canonicalJson(value: unknown, seen = new Set<object>()): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value);
  if (typeof value === "number" && Number.isFinite(value)) return JSON.stringify(value);
  if (typeof value !== "object" || value === undefined) {
    throw new MissionLeaseContractError("INVALID_DISPATCH_INTENT", "Execution payload must contain only JSON values.");
  }
  if (seen.has(value)) throw new MissionLeaseContractError("INVALID_DISPATCH_INTENT", "Execution payload cannot contain cycles.");
  seen.add(value);
  try {
    if (Array.isArray(value)) return "[" + value.map((item) => canonicalJson(item, seen)).join(",") + "]";
    const prototype = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw new MissionLeaseContractError("INVALID_DISPATCH_INTENT", "Execution payload objects must be plain JSON objects.");
    }
    const record = value as Record<string, unknown>;
    return "{" + Object.keys(record).sort().map((key) => JSON.stringify(key) + ":" + canonicalJson(record[key], seen)).join(",") + "}";
  } finally {
    seen.delete(value);
  }
}

/** Canonical SHA-256 over the complete immutable execution request. */
export function createExecutionPayloadDigest(request: ExecutionRequest): string {
  const payload = {
    id: request.id,
    taskId: request.taskId,
    missionId: request.missionId,
    capability: request.capability,
    action: request.action,
    input: request.input,
    targetReference: request.targetReference ?? null,
    requiresApproval: request.requiresApproval,
    approved: request.approved,
    risk: request.risk,
    createdAt: request.createdAt,
  };
  return "sha256:" + createHash("sha256").update(canonicalJson(payload)).digest("hex");
}

/** Stable tenant- and attempt-bound key; the raw principal/scope is not exposed in the key. */
export function createExecutionIdempotencyKey(lease: MissionTaskLease, request: ExecutionRequest): string {
  validateLease(lease);
  const binding = [
    lease.scope.organizationId, lease.scope.workspaceId, lease.scope.userId,
    lease.missionId, lease.taskId, String(lease.attempt),
    request.id, request.capability, request.action,
  ].join("\u001f");
  return "happy-dispatch:v1:" + createHash("sha256").update(binding).digest("hex");
}

/** Checks exact dispatch binding before an outbox insert; it does not deduplicate side effects. */
export function assertExecutionDispatchBinding(intent: ExecutionDispatchIntent, lease: MissionTaskLease, request: ExecutionRequest): void {
  validateLease(lease);
  assertCompleteScope(intent.scope);
  if (!intent.id.trim() || !intent.idempotencyKey.trim() || !intent.executionRequestId.trim() || !/^sha256:[a-f0-9]{64}$/.test(intent.payloadDigest) || !Number.isFinite(Date.parse(intent.createdAt))) {
    throw new MissionLeaseContractError("INVALID_DISPATCH_INTENT", "Dispatch intent identity, digest, or timestamp is invalid.");
  }
  if (!sameScope(intent.scope, lease.scope) || intent.missionId !== lease.missionId ||
      intent.taskId !== lease.taskId || intent.attempt !== lease.attempt ||
      intent.executionRequestId !== request.id ||
      intent.idempotencyKey !== createExecutionIdempotencyKey(lease, request) ||
      intent.payloadDigest !== createExecutionPayloadDigest(request) ||
      intent.missionId !== request.missionId || intent.taskId !== request.taskId ||
      intent.capability !== request.capability || intent.action !== request.action) {
    throw new MissionLeaseContractError("DISPATCH_BINDING_MISMATCH", "Dispatch intent does not match its lease and execution request.");
  }
}