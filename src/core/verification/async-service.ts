import type { AsyncHappyStateStore } from "../state/async-happy-state-store";
import type { Evidence } from "../evidence/types";
import type { Mission, MissionTask } from "../mission/types";
import type { ExecutionRequest } from "../execution/types";
import type { VerificationRequest, VerificationResult } from "./types";

function isVerificationResult(value: unknown): value is VerificationResult {
  return Boolean(
    value && typeof value === "object" &&
    "requestId" in value && "status" in value && "evidenceIds" in value,
  );
}

/**
 * Tenant-scoped verification lifecycle.
 *
 * Requests are registered only after their mission/task/execution ownership
 * is checked against the same tenant repository. Results are append-only.
 * This is a persistence contract; production durability still depends on a
 * real adapter enforcing tenant scope and atomic uniqueness at storage level.
 */
export class AsyncVerificationService {
  constructor(
    private readonly state: AsyncHappyStateStore,
  ) {}

  async registerRequest(request: VerificationRequest): Promise<VerificationRequest> {
    const normalized = this.normalizeRequest(request);

    // Keep ownership validation and request creation in one storage transaction.
    // Otherwise a mission/task/execution could be changed or removed between
    // the reads and the insert, leaving a verification request bound to stale
    // or unrelated work. Production adapters must provide real transaction
    // isolation; the in-memory adapter is only a test contract.
    return this.state.transaction(async (transactionState) => {
      const [missionRecord, taskRecord] = await Promise.all([
        transactionState.mission<Mission>().get(normalized.missionId),
        transactionState.task<MissionTask>().get(normalized.taskId),
      ]);
      if (!missionRecord || !taskRecord) {
        throw new Error("Verification mission and task must exist in the active tenant.");
      }
      if (missionRecord.id !== normalized.missionId ||
          missionRecord.data.id !== normalized.missionId ||
          taskRecord.id !== normalized.taskId ||
          taskRecord.data.id !== normalized.taskId ||
          taskRecord.data.missionId !== normalized.missionId ||
          !missionRecord.data.taskIds.includes(normalized.taskId)) {
        throw new Error("Verification task does not belong to the requested mission.");
      }

      if (normalized.executionRequestId) {
        const execution = await transactionState.execution<ExecutionRequest>().get(normalized.executionRequestId);
        if (!execution ||
            execution.id !== normalized.executionRequestId ||
            execution.data.id !== normalized.executionRequestId ||
            execution.data.missionId !== normalized.missionId ||
            execution.data.taskId !== normalized.taskId) {
          throw new Error("Verification execution request does not match the mission and task.");
        }
      }

      await transactionState.verificationRequest<VerificationRequest>().create(
        normalized.id,
        normalized,
      );
      return normalized;
    });
  }

  async verify(
    requestId: string,
    observedEvidenceIds: string[],
  ): Promise<VerificationResult> {
    const normalizedId = requestId.trim();
    if (!normalizedId) throw new Error("Verification request ID is required.");
    if (!Array.isArray(observedEvidenceIds)) {
      throw new Error("Observed evidence IDs must be an array.");
    }

    // Read the registered request, provenance records, and append the result
    // within one tenant transaction. This guarantees atomic rollback and
    // same-connection execution; snapshot consistency and concurrent-writer
    // behavior remain explicit responsibilities of the concrete adapter.
    return this.state.transaction(async (transactionState) => {
      const storedRequest = await transactionState
        .verificationRequest<VerificationRequest>()
        .get(normalizedId);
      if (!storedRequest) {
        throw new Error("Verification request is not registered in the active tenant.");
      }
      const request = storedRequest.data;
      if (storedRequest.id !== normalizedId || request.id !== normalizedId) {
        throw new Error("Verification request storage identity does not match its registered ID.");
      }

      // One immutable result per request. A repeated call returns the first
      // persisted decision instead of silently replacing its evidence snapshot.
      const existingResult = await transactionState
        .verification<VerificationResult>()
        .get(normalizedId);
      if (existingResult) {
        if (existingResult.id !== normalizedId ||
            existingResult.data.id !== normalizedId ||
            existingResult.data.requestId !== normalizedId) {
          throw new Error("Persisted verification result identity does not match its request.");
        }
        return existingResult.data;
      }

      const uniqueEvidenceIds = [...new Set(
        observedEvidenceIds
          .filter((id) => typeof id === "string" && id.trim())
          .map((id) => id.trim()),
      )];
      const evidenceRows = await Promise.all(
        uniqueEvidenceIds.map((id) => transactionState.evidence<Evidence>().get(id)),
      );
      const matchedEvidence = evidenceRows.flatMap((item) =>
        item && item.id === item.data.id && this.matchesRequest(item.data, request) ? [item] : [],
      );
      const evidenceIds = matchedEvidence.map((item) => item.id);
      const requiredCriteria = request.criteria.filter((criterion) => criterion.required);

      let result: VerificationResult;
      if (request.criteria.length === 0) {
        result = this.result(request, {
          status: "BLOCKED",
          confidence: "UNKNOWN",
          passedCriteria: [],
          failedCriteria: [],
          partialCriteria: [],
          evidenceIds: [],
          summary: "Verification requires at least one criterion.",
          failureReason: "NO_CRITERIA",
        });
      } else if (request.requiresEvidence && evidenceIds.length === 0) {
        result = this.result(request, {
          status: "FAILED",
          confidence: "HIGH",
          passedCriteria: [],
          failedCriteria: requiredCriteria.map((criterion) => criterion.id),
          partialCriteria: [],
          evidenceIds: [],
          summary: "Required evidence is missing or does not match this verification request.",
          failureReason: "REQUIRED_EVIDENCE_MISSING_OR_MISMATCHED",
        });
      } else {
        result = this.result(request, {
          status: "PARTIAL",
          confidence: "LOW",
          passedCriteria: [],
          failedCriteria: [],
          partialCriteria: (requiredCriteria.length > 0 ? requiredCriteria : request.criteria)
            .map((criterion) => criterion.id),
          evidenceIds,
          summary: "Evidence provenance was checked, but semantic outcome verification is not connected.",
          failureReason: "SEMANTIC_VERIFIER_NOT_CONNECTED",
        });
      }

      await transactionState.verification<VerificationResult>().create(result.id, result);
      return result;
    });
  }

  async get(id: string): Promise<VerificationResult | undefined> {
    const record = await this.state.verification<VerificationResult>().get(id);
    return record && isVerificationResult(record.data) ? record.data : undefined;
  }

  async forRequest(requestId: string): Promise<VerificationResult[]> {
    const normalizedId = requestId.trim();
    if (!normalizedId) return [];
    const records = await this.state.verification<VerificationResult>().list();
    return records
      .map((record) => record.data)
      .filter((result) => isVerificationResult(result) && result.requestId === normalizedId);
  }

  private normalizeRequest(request: VerificationRequest): VerificationRequest {
    if (!request.id?.trim() || !request.missionId?.trim() || !request.taskId?.trim()) {
      throw new Error("Verification, mission, and task IDs are required.");
    }
    if (!request.description?.trim() || !Array.isArray(request.criteria) ||
        !Array.isArray(request.preferredMethods)) {
      throw new Error("Verification description, criteria, and methods are required.");
    }
    const criteria = request.criteria.map((criterion) => ({
      ...criterion,
      id: criterion.id?.trim(),
      description: criterion.description?.trim(),
      expected: criterion.expected?.trim(),
    }));
    if (criteria.some((criterion) =>
      !criterion.id || !criterion.description || !criterion.expected ||
      typeof criterion.required !== "boolean")) {
      throw new Error("Every verification criterion must have an ID, description, expected value, and required flag.");
    }
    if (new Set(criteria.map((criterion) => criterion.id)).size !== criteria.length) {
      throw new Error("Verification criterion IDs must be unique.");
    }
    return {
      ...structuredClone(request),
      id: request.id.trim(),
      missionId: request.missionId.trim(),
      taskId: request.taskId.trim(),
      executionRequestId: request.executionRequestId?.trim() || undefined,
      description: request.description.trim(),
      criteria,
      preferredMethods: [...new Set(request.preferredMethods)],
    };
  }

  private matchesRequest(evidence: Evidence, request: VerificationRequest): boolean {
    return evidence.verificationRequestId === request.id &&
      evidence.missionId === request.missionId &&
      evidence.taskId === request.taskId &&
      (evidence.executionRequestId || undefined) === (request.executionRequestId || undefined);
  }

  private result(
    request: VerificationRequest,
    fields: Omit<VerificationResult, "id" | "requestId" | "verifiedAt">,
  ): VerificationResult {
    return {
      // The request ID is the stable primary key for its immutable result.
      // This lets completion gates resolve the exact result without a global scan.
      id: request.id,
      requestId: request.id,
      ...fields,
      verifiedAt: new Date().toISOString(),
    };
  }
}
