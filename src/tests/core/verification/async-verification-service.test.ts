import { AsyncEvidenceService } from "../../../core/evidence/async-service";
import { InMemoryTenantPersistenceAdapter } from "../../../core/persistence/adapters/in-memory-tenant-adapter";
import { createAsyncHappyStateStore } from "../../../core/state/async-factory";
import { AsyncVerificationService } from "../../../core/verification/async-service";
import type { VerificationRequest } from "../../../core/verification/types";

async function main(): Promise<void> {
  const adapter = new InMemoryTenantPersistenceAdapter();
  const ownerStore = createAsyncHappyStateStore(adapter, "org-1", "workspace-1", "user-1");
  const otherStore = createAsyncHappyStateStore(adapter, "org-1", "workspace-1", "user-2");
  const evidence = new AsyncEvidenceService(ownerStore);
  const verifier = new AsyncVerificationService(ownerStore, evidence);
  const otherVerifier = new AsyncVerificationService(
    otherStore,
    new AsyncEvidenceService(otherStore),
  );

  const request: VerificationRequest = {
    id: "verify-1",
    missionId: "mission-1",
    taskId: "task-1",
    executionRequestId: "execution-1",
    description: "Confirm task outcome",
    criteria: [{ id: "criterion-1", description: "Expected outcome", expected: "complete", required: true }],
    preferredMethods: ["TEST"],
    requiresEvidence: true,
    createdAt: new Date().toISOString(),
  };

  const valid = await evidence.capture({
    verificationRequestId: request.id,
    missionId: request.missionId,
    taskId: request.taskId,
    executionRequestId: request.executionRequestId,
    type: "TEST_RESULT",
    source: "TEST",
    title: "Matching evidence",
    content: "Synthetic test evidence only.",
  });
  const mismatched = await evidence.capture({
    verificationRequestId: request.id,
    missionId: request.missionId,
    taskId: "another-task",
    executionRequestId: request.executionRequestId,
    type: "TEST_RESULT",
    source: "TEST",
    title: "Wrong task evidence",
    content: "Must not be attached to this result.",
  });

  const wrongExecution = await evidence.capture({
    verificationRequestId: request.id,
    missionId: request.missionId,
    taskId: request.taskId,
    executionRequestId: "another-execution",
    type: "TEST_RESULT",
    source: "TEST",
    title: "Wrong execution evidence",
    content: "Must not be attached to this result.",
  });
  const wrongRequest = await evidence.capture({
    verificationRequestId: "another-verification",
    missionId: request.missionId,
    taskId: request.taskId,
    executionRequestId: request.executionRequestId,
    type: "TEST_RESULT",
    source: "TEST",
    title: "Wrong verification evidence",
    content: "Must not be attached to this result.",
  });

  const result = await verifier.verify(request, [valid.id, mismatched.id, wrongExecution.id, wrongRequest.id, valid.id]);
  if (result.status !== "PARTIAL" || result.failureReason !== "SEMANTIC_VERIFIER_NOT_CONNECTED") {
    throw new Error("Evidence presence was incorrectly treated as semantic success.");
  }
  if (result.evidenceIds.length !== 1 || result.evidenceIds[0] !== valid.id) {
    throw new Error("Verification accepted evidence with mismatched provenance or duplicate IDs.");
  }
  const persisted = await verifier.get(result.id);
  if (!persisted || persisted.requestId !== request.id) {
    throw new Error("Verification result was not persisted through the tenant repository.");
  }
  if ((await verifier.forRequest(" verify-1 ")).length !== 1) {
    throw new Error("Verification request lookup returned the wrong records.");
  }
  if (await otherVerifier.get(result.id)) {
    throw new Error("Verification result leaked across tenant users.");
  }

  const missing = await verifier.verify(
    { ...request, id: "verify-missing" },
    [mismatched.id],
  );
  if (missing.status !== "FAILED" || missing.failureReason !== "REQUIRED_EVIDENCE_MISSING_OR_MISMATCHED") {
    throw new Error("Missing or mismatched required evidence did not fail closed.");
  }

  const noCriteria = await verifier.verify(
    { ...request, id: "verify-no-criteria", criteria: [] },
    [],
  );
  if (noCriteria.status !== "BLOCKED" || noCriteria.failureReason !== "NO_CRITERIA") {
    throw new Error("Empty verification criteria did not block verification.");
  }

  console.log("Async tenant-scoped verification service: PASS");
  console.log({
    persistedResult: true,
    tenantIsolation: true,
    provenanceBinding: true,
    semanticSuccessFailClosed: true,
    missingEvidenceFailClosed: true,
    emptyCriteriaBlocked: true,
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
