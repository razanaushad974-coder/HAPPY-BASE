import type { AsyncHappyStateStore } from "../state/async-happy-state-store";
import type { AsyncEvidenceService } from "../evidence/async-service";
import type { Evidence } from "../evidence/types";
import type { VerificationRequest, VerificationResult } from "./types";

/**
 * Tenant-scoped, append-only verification result service.
 *
 * It validates provenance links before associating evidence with a result.
 * It deliberately does not claim semantic success: without a connected
 * capability-specific verifier, criteria remain PARTIAL.
 */
export class AsyncVerificationService {
  constructor(
    private readonly state: AsyncHappyStateStore,
    private readonly evidence: AsyncEvidenceService,
  ) {}

  async verify(
    request: VerificationRequest,
    observedEvidenceIds: string[],
  ): Promise<VerificationResult> {
    if (!request.id?.trim()) {
      throw new Error("Verification request ID is required.");
    }
    if (!request.missionId?.trim() || !request.taskId?.trim()) {
      throw new Error("Verification mission ID and task ID are required.");
    }
    if (!Array.isArray(request.criteria)) {
      throw new Error("Verification criteria must be an array.");
    }

    const criteria = request.criteria;
    const uniqueEvidenceIds = [...new Set(
      observedEvidenceIds.filter((id) => typeof id === "string" && id.trim()).map((id) => id.trim()),
    )];
    const evidenceRows = await Promise.all(
      uniqueEvidenceIds.map((id) => this.evidence.get(id)),
    );
    const matchedEvidence = evidenceRows.filter(
      (item): item is Evidence => Boolean(item && this.matchesRequest(item, request)),
    );
    const evidenceIds = matchedEvidence.map((item) => item.id);
    const requiredCriteria = criteria.filter((criterion) => criterion.required);

    let result: VerificationResult;
    if (criteria.length === 0) {
      result = {
        id: `verification-result-${crypto.randomUUID()}`,
        requestId: request.id.trim(),
        status: "BLOCKED",
        confidence: "UNKNOWN",
        passedCriteria: [],
        failedCriteria: [],
        partialCriteria: [],
        evidenceIds: [],
        summary: "Verification requires at least one criterion.",
        failureReason: "NO_CRITERIA",
        verifiedAt: new Date().toISOString(),
      };
    } else if (request.requiresEvidence && evidenceIds.length === 0) {
      result = {
        id: `verification-result-${crypto.randomUUID()}`,
        requestId: request.id.trim(),
        status: "FAILED",
        confidence: "HIGH",
        passedCriteria: [],
        failedCriteria: requiredCriteria.map((criterion) => criterion.id),
        partialCriteria: [],
        evidenceIds: [],
        summary: "Required evidence is missing or does not match this verification request.",
        failureReason: "REQUIRED_EVIDENCE_MISSING_OR_MISMATCHED",
        verifiedAt: new Date().toISOString(),
      };
    } else {
      result = {
        id: `verification-result-${crypto.randomUUID()}`,
        requestId: request.id.trim(),
        status: "PARTIAL",
        confidence: "LOW",
        passedCriteria: [],
        failedCriteria: [],
        partialCriteria: (requiredCriteria.length > 0 ? requiredCriteria : criteria)
          .map((criterion) => criterion.id),
        evidenceIds,
        summary: "Evidence provenance was checked, but semantic outcome verification is not connected.",
        failureReason: "SEMANTIC_VERIFIER_NOT_CONNECTED",
        verifiedAt: new Date().toISOString(),
      };
    }

    await this.state.verification<VerificationResult>().create(result.id, result);
    return result;
  }

  async get(id: string): Promise<VerificationResult | undefined> {
    const record = await this.state.verification<VerificationResult>().get(id);
    return record?.data;
  }

  async forRequest(requestId: string): Promise<VerificationResult[]> {
    const normalizedId = requestId.trim();
    if (!normalizedId) return [];
    const records = await this.state.verification<VerificationResult>().list();
    return records
      .map((record) => record.data)
      .filter((result) => result.requestId === normalizedId);
  }

  private matchesRequest(
    evidence: Evidence,
    request: VerificationRequest,
  ): boolean {
    return evidence.verificationRequestId === request.id.trim() &&
      evidence.missionId === request.missionId.trim() &&
      evidence.taskId === request.taskId.trim() &&
      (request.executionRequestId === undefined ||
        evidence.executionRequestId === request.executionRequestId.trim());
  }
}
