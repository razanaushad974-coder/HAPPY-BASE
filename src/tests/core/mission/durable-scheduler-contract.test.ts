import type { ExecutionRequest } from "../../../core/execution/types";
import { assertCurrentMissionTaskLease, assertExecutionDispatchBinding, createExecutionIdempotencyKey, createExecutionPayloadDigest, MissionLeaseContractError, type MissionTaskLease } from "../../../core/mission/durable-scheduler-contract";

const lease: MissionTaskLease = {
  id: "lease-1",
  scope: { organizationId: "org-1", workspaceId: "workspace-1", userId: "user-1" },
  missionId: "mission-1", taskId: "task-1", ownerId: "worker-1",
  attempt: 2, fencingToken: 7, expiresAt: "2026-11-21T13:00:00.000Z",
};
const now = Date.parse("2026-11-21T12:00:00.000Z");
assertCurrentMissionTaskLease(lease, { ...lease }, now);

function expectCode(operation: () => void, expected: string): void {
  try { operation(); } catch (error) {
    if (error instanceof MissionLeaseContractError && error.code === expected) return;
    throw error;
  }
  throw new Error("Expected contract error: " + expected);
}

expectCode(() => assertCurrentMissionTaskLease(lease, { ...lease, fencingToken: 6 }, now), "STALE_FENCING_TOKEN");
expectCode(() => assertCurrentMissionTaskLease(lease, { ...lease, ownerId: "worker-2" }, now), "LEASE_IDENTITY_MISMATCH");
expectCode(() => assertCurrentMissionTaskLease(lease, { ...lease }, Date.parse(lease.expiresAt)), "LEASE_EXPIRED");
expectCode(() => assertCurrentMissionTaskLease(lease, { ...lease, scope: { ...lease.scope, workspaceId: "workspace-2" } }, now), "LEASE_IDENTITY_MISMATCH");

const request: ExecutionRequest = {
  id: "request-1", taskId: "task-1", missionId: "mission-1", capability: "API", action: "POST",
  input: { resource: "example" }, requiresApproval: false, approved: false, risk: "LOW",
  createdAt: "2026-11-21T11:59:00.000Z",
};
const intent = {
  id: "outbox-1", idempotencyKey: createExecutionIdempotencyKey(lease, request),
  executionRequestId: request.id, payloadDigest: createExecutionPayloadDigest(request), scope: lease.scope,
  missionId: lease.missionId, taskId: lease.taskId, attempt: lease.attempt,
  capability: request.capability, action: request.action, createdAt: "2026-11-21T12:00:00.000Z",
};
assertExecutionDispatchBinding(intent, lease, request);
expectCode(() => assertExecutionDispatchBinding({ ...intent, attempt: 1 }, lease, request), "DISPATCH_BINDING_MISMATCH");
expectCode(() => assertExecutionDispatchBinding({ ...intent, scope: { ...intent.scope, userId: "other-user" } }, lease, request), "DISPATCH_BINDING_MISMATCH");
expectCode(() => assertExecutionDispatchBinding({ ...intent, action: "DELETE" }, lease, request), "DISPATCH_BINDING_MISMATCH");
expectCode(() => assertExecutionDispatchBinding({ ...intent, executionRequestId: "other-request" }, lease, request), "DISPATCH_BINDING_MISMATCH");
expectCode(() => assertExecutionDispatchBinding({ ...intent, idempotencyKey: "reused-key" }, lease, request), "DISPATCH_BINDING_MISMATCH");
expectCode(() => assertExecutionDispatchBinding({ ...intent, payloadDigest: "sha256:" + "0".repeat(64) }, lease, request), "DISPATCH_BINDING_MISMATCH");
expectCode(() => assertExecutionDispatchBinding({ ...intent, payloadDigest: "not-a-digest" }, lease, request), "INVALID_DISPATCH_INTENT");
const reorderedRequest = { ...request, input: { resource: "example" } };
if (createExecutionPayloadDigest(reorderedRequest) !== createExecutionPayloadDigest(request)) throw new Error("Canonical payload digest changed with equivalent object ordering.");

console.log("Durable scheduler lease/dispatch contract tests: PASS");