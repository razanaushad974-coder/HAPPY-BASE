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
  const otherVerifier = new AsyncVerificationService(otherStore, new AsyncEvidenceService(otherStore));

  await ownerStore.mission().create("mission-1", {
    id: "mission-1", taskIds: ["task-1"], status: "READY",
  });
  await ownerStore.task().create("task-1", {
    id: "task-1", missionId: "mission-1", status: "READY",
  });
  await ownerStore.execution().create("execution-1", {
    id: "execution-1", missionId: "mission-1", taskId: "task-1",
  });

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
  await verifier.registerRequest(request);
  const storedRequest = await ownerStore.verificationRequest<VerificationRequest>().get(request.id);
  if (!storedRequest || storedRequest.entityType !== "VERIFICATION_REQUEST") {
    throw new Error("Verification request was not stored in its dedicated entity type.");
  }

  let unregisteredDenied = false;
  try {
    await verifier.verify("not-registered", []);
  } catch {
    unregisteredDenied = true;
  }
  if (!unregisteredDenied) throw new Error("Unregistered verification request was accepted.");

  let crossMissionDenied = false;
  try {
    await verifier.registerRequest({ ...request, id: "cross-mission", missionId: "other-mission" });
  } catch {
    crossMissionDenied = true;
  }
  if (!crossMissionDenied) throw new Error("Verification request with mismatched mission/task was accepted.");

  const valid = await evidence.capture({
    verificationRequestId: request.id, missionId: request.missionId, taskId: request.taskId,
    executionRequestId: request.executionRequestId, type: "TEST_RESULT", source: "TEST",
    title: "Matching evidence", content: "Synthetic test evidence only.",
  });
  const wrongTask = await evidence.capture({
    verificationRequestId: request.id, missionId: request.missionId, taskId: "another-task",
    executionRequestId: request.executionRequestId, type: "TEST_RESULT", source: "TEST",
    title: "Wrong task evidence", content: "Must not be attached.",
  });
  const wrongExecution = await evidence.capture({
    verificationRequestId: request.id, missionId: request.missionId, taskId: request.taskId,
    executionRequestId: "another-execution", type: "TEST_RESULT", source: "TEST",
    title: "Wrong execution evidence", content: "Must not be attached.",
  });
  const wrongRequest = await evidence.capture({
    verificationRequestId: "another-verification", missionId: request.missionId, taskId: request.taskId,
    executionRequestId: request.executionRequestId, type: "TEST_RESULT", source: "TEST",
    title: "Wrong verification evidence", content: "Must not be attached.",
  });

  const result = await verifier.verify(request.id, [valid.id, wrongTask.id, wrongExecution.id, wrongRequest.id, valid.id]);
  if (result.status !== "PARTIAL" || result.failureReason !== "SEMANTIC_VERIFIER_NOT_CONNECTED") {
    throw new Error("Evidence presence was incorrectly treated as semantic success.");
  }
  if (result.evidenceIds.length !== 1 || result.evidenceIds[0] !== valid.id) {
    throw new Error("Verification accepted mismatched provenance or duplicate evidence IDs.");
  }
  const persisted = await verifier.get(result.id);
  const persistedResultRecord = await ownerStore.verification().get(result.id);
  if (!persisted || persisted.requestId !== request.id || persistedResultRecord?.entityType !== "VERIFICATION") {
    throw new Error("Verification result was not persisted in the result entity type.");
  }
  if ((await verifier.forRequest(" verify-1 ")).length !== 1) throw new Error("Request result lookup failed.");
  if (await otherVerifier.get(result.id)) throw new Error("Verification result leaked across tenant users.");

  const missingRequest: VerificationRequest = { ...request, id: "verify-missing" };
  await verifier.registerRequest(missingRequest);
  const missing = await verifier.verify(missingRequest.id, [wrongTask.id]);
  if (missing.status !== "FAILED" || missing.failureReason !== "REQUIRED_EVIDENCE_MISSING_OR_MISMATCHED") {
    throw new Error("Missing or mismatched required evidence did not fail closed.");
  }

  const noCriteria: VerificationRequest = { ...request, id: "verify-no-criteria", criteria: [] };
  await verifier.registerRequest(noCriteria);
  const blocked = await verifier.verify(noCriteria.id, []);
  if (blocked.status !== "BLOCKED" || blocked.failureReason !== "NO_CRITERIA") {
    throw new Error("Empty verification criteria did not block verification.");
  }

  console.log("Async tenant-scoped verification lifecycle: PASS");
  console.log({
    persistedRequestAndResult: true, missionTaskExecutionBinding: true,
    tenantIsolation: true, evidenceProvenance: true, semanticSuccessFailClosed: true,
  });
}
main().catch((error: unknown) => { console.error(error); process.exitCode = 1; });
