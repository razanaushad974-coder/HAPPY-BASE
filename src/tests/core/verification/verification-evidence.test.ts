import { InMemoryEvidenceRepository } from "../../../core/evidence/repository";
import { EvidenceService } from "../../../core/evidence/service";
import { VerificationEngine } from "../../../core/verification/engine";
import { VerificationOrchestrator } from "../../../core/verification/orchestrator";
import type { VerificationRequest } from "../../../core/verification/types";

async function main(): Promise<void> {
  const repository = new InMemoryEvidenceRepository();
  const evidenceService = new EvidenceService(repository);
  const engine = new VerificationEngine(evidenceService);
  const orchestrator = new VerificationOrchestrator(engine);

  const request: VerificationRequest = {
    id: "verification-1",
    missionId: "mission-1",
    taskId: "task-1",
    executionRequestId: "execution-1",
    description: "Verify generated application result.",
    criteria: [
      {
        id: "criterion-1",
        description: "Expected application output exists.",
        expected: "Application output exists.",
        required: true,
      },
      {
        id: "criterion-2",
        description: "Verification evidence is attached.",
        expected: "At least one evidence item exists.",
        required: true,
      },
    ],
    preferredMethods: ["TEST", "FILE", "SCREENSHOT"],
    requiresEvidence: true,
    createdAt: new Date().toISOString(),
  };

  const missingEvidence = orchestrator.verify(request, []);

  if (missingEvidence.status !== "FAILED") {
    throw new Error("Missing evidence was not rejected.");
  }

  if (missingEvidence.failureReason !== "REQUIRED_EVIDENCE_MISSING") {
    throw new Error("Missing-evidence failure reason is incorrect.");
  }

  const evidence = evidenceService.capture({
    verificationRequestId: request.id,
    executionRequestId: request.executionRequestId,
    missionId: request.missionId,
    taskId: request.taskId,
    type: "TEST_RESULT",
    source: "TEST",
    title: "Foundation verification test result",
    content: "Synthetic evidence captured by the Step 17 foundation test.",
    metadata: {
      synthetic: true,
      realWorldClaim: false,
    },
    isPrimary: true,
  });

  const result = orchestrator.verify(request, [evidence.id]);

  if (result.status !== "PARTIAL") {
    throw new Error("Unconnected semantic verification was not marked PARTIAL.");
  }

  if (result.confidence !== "LOW") {
    throw new Error("Unconnected semantic verification confidence is incorrect.");
  }

  if (!result.evidenceIds.includes(evidence.id)) {
    throw new Error("Evidence was not linked to verification result.");
  }

  if (result.failureReason !== "SEMANTIC_VERIFIER_NOT_CONNECTED") {
    throw new Error("Semantic-verifier NOT_YET_CONNECTED state is incorrect.");
  }

  const invalidRequest: VerificationRequest = {
    ...request,
    id: "verification-no-criteria",
    criteria: [],
  };

  const blocked = orchestrator.verify(invalidRequest, [evidence.id]);

  if (blocked.status !== "BLOCKED") {
    throw new Error("Empty verification criteria were not blocked.");
  }

  if (repository.count() !== 1) {
    throw new Error("Unexpected evidence repository count.");
  }

  console.log("Verification + Evidence test: PASS");
  console.log({
    verificationStatus: result.status,
    missingEvidenceRejected: missingEvidence.status === "FAILED",
    evidenceCaptured: repository.count(),
    evidenceLinked: result.evidenceIds.length,
    semanticVerifierNotConnected:
      result.failureReason === "SEMANTIC_VERIFIER_NOT_CONNECTED",
    emptyCriteriaBlocked: blocked.status === "BLOCKED",
    fakePassPrevented: result.status === "PARTIAL",
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});

