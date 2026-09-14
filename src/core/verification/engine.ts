import type {
  VerificationRequest,
  VerificationResult,
} from "./types";
import type { EvidenceService } from "../evidence/service";

export class VerificationEngine {
  constructor(private readonly evidence: EvidenceService) {}

  verify(
    request: VerificationRequest,
    observedEvidenceIds: string[],
  ): VerificationResult {
    if (request.criteria.length === 0) {
      return {
        id: `verification-result-${request.id}`,
        requestId: request.id,
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
    }

    const evidenceIds = observedEvidenceIds.filter(
      (id) => this.evidence.get(id) !== undefined,
    );

    if (request.requiresEvidence && evidenceIds.length === 0) {
      return {
        id: `verification-result-${request.id}`,
        requestId: request.id,
        status: "FAILED",
        confidence: "HIGH",
        passedCriteria: [],
        failedCriteria: request.criteria
          .filter((criterion) => criterion.required)
          .map((criterion) => criterion.id),
        partialCriteria: [],
        evidenceIds: [],
        summary: "Verification failed because required evidence is missing.",
        failureReason: "REQUIRED_EVIDENCE_MISSING",
        verifiedAt: new Date().toISOString(),
      };
    }

    /*
     * Foundation behavior:
     * Evidence presence proves that evidence was captured.
     * It does NOT pretend to prove the real-world criterion itself.
     *
     * Real semantic verification will be connected later to:
     * browser observations, API responses, DB queries,
     * test runners, screenshots, files and AI reasoning.
     */

    const requiredCriteria = request.criteria.filter(
      (criterion) => criterion.required,
    );

    if (requiredCriteria.length === 0) {
      return {
        id: `verification-result-${request.id}`,
        requestId: request.id,
        status: "PARTIAL",
        confidence: "LOW",
        passedCriteria: [],
        failedCriteria: [],
        partialCriteria: request.criteria.map((criterion) => criterion.id),
        evidenceIds,
        summary:
          "Evidence was captured, but no required semantic verification criteria were evaluated.",
        verifiedAt: new Date().toISOString(),
      };
    }

    return {
      id: `verification-result-${request.id}`,
      requestId: request.id,
      status: "PARTIAL",
      confidence: "LOW",
      passedCriteria: [],
      failedCriteria: [],
      partialCriteria: requiredCriteria.map((criterion) => criterion.id),
      evidenceIds,
      summary:
        "Evidence exists, but real semantic outcome verification is not yet connected.",
      failureReason: "SEMANTIC_VERIFIER_NOT_CONNECTED",
      verifiedAt: new Date().toISOString(),
    };
  }
}
