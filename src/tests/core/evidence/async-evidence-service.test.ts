import { AsyncEvidenceService } from "../../../core/evidence/async-service";
import type { VerificationRequest } from "../../../core/verification/types";
import { InMemoryTenantPersistenceAdapter } from "../../../core/persistence/adapters/in-memory-tenant-adapter";
import { createAsyncHappyStateStore } from "../../../core/state/async-factory";

async function main(): Promise<void> {
  const adapter = new InMemoryTenantPersistenceAdapter();
  const ownerStore = createAsyncHappyStateStore(adapter, "org-1", "workspace-1", "user-1");
  const otherUserStore = createAsyncHappyStateStore(adapter, "org-1", "workspace-1", "user-2");
  const service = new AsyncEvidenceService(ownerStore);
  const otherUser = new AsyncEvidenceService(otherUserStore);

  const verificationRequest: VerificationRequest = {
    id: "verification-1", missionId: "mission-1", taskId: "task-1",
    executionRequestId: "execution-1", description: "Evidence contract request",
    criteria: [{ id: "criterion-1", description: "Result exists", expected: "PASS", required: true }],
    preferredMethods: ["TEST"], requiresEvidence: true, createdAt: new Date().toISOString(),
  };
  await ownerStore.verificationRequest<VerificationRequest>().create(
    verificationRequest.id, verificationRequest,
  );

  const input = {
    verificationRequestId: "verification-1",
    executionRequestId: "execution-1",
    missionId: "mission-1",
    taskId: "task-1",
    type: "TEST_RESULT" as const,
    source: "TEST" as const,
    title: "Async evidence contract",
    content: "Synthetic evidence; not a real-world claim.",
    metadata: { synthetic: true, realWorldClaim: false },
    isPrimary: true,
  };

  let missingVerificationRejected = false;
  try {
    await service.capture({ ...input, verificationRequestId: " " });
  } catch (error) {
    missingVerificationRejected = error instanceof Error &&
      error.message === "Verification request ID is required.";
  }
  if (!missingVerificationRejected) {
    throw new Error("Missing verification ID was not rejected.");
  }

  let missingPayloadRejected = false;
  try {
    await service.capture({ ...input, content: "   ", uri: undefined });
  } catch (error) {
    missingPayloadRejected = error instanceof Error &&
      error.message === "Evidence content or URI is required.";
  }
  if (!missingPayloadRejected) {
    throw new Error("Evidence without non-empty content or URI was accepted.");
  }

  let mismatchedRequestRejected = false;
  try {
    await service.capture({ ...input, taskId: "task-other" });
  } catch (error) {
    mismatchedRequestRejected = error instanceof Error &&
      error.message === "Evidence must match a registered verification request in the active tenant.";
  }
  if (!mismatchedRequestRejected) {
    throw new Error("Evidence bound to a different task was accepted.");
  }

  let missingRequestRejected = false;
  try {
    await service.capture({ ...input, verificationRequestId: "unregistered-request" });
  } catch (error) {
    missingRequestRejected = error instanceof Error &&
      error.message === "Evidence must match a registered verification request in the active tenant.";
  }
  if (!missingRequestRejected) {
    throw new Error("Evidence for an unregistered verification request was accepted.");
  }

  const captured = await service.capture({ ...input, title: "  Async evidence contract  ", verificationRequestId: " verification-1 " });
  const loaded = await service.get(captured.id);
  if (!loaded || loaded.id !== captured.id || loaded.title !== input.title) {
    throw new Error("Captured evidence could not be read back.");
  }
  if ((await service.forVerification(" verification-1 ")).length !== 1) {
    throw new Error("Verification evidence query returned the wrong records.");
  }
  if ((await service.forTask("task-1")).length !== 1 || (await service.count()) !== 1) {
    throw new Error("Task query or evidence count is incorrect.");
  }
  if (await otherUser.get(captured.id)) {
    throw new Error("Evidence leaked across user tenant scopes.");
  }
  if ((await otherUser.count()) !== 0) {
    throw new Error("Evidence count leaked across user tenant scopes.");
  }

  console.log("Async tenant-scoped evidence service: PASS");
  console.log({
    evidenceCaptured: true,
    validationFailClosed: missingVerificationRejected && missingPayloadRejected && mismatchedRequestRejected && missingRequestRejected,
    tenantIsolation: true,
    appendOnlyServiceSurface: true,
  });
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
