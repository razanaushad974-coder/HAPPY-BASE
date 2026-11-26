import type { AsyncHappyStateStore } from "../state/async-happy-state-store";
import type { Evidence, EvidenceInput } from "./types";
import type { VerificationRequest } from "../verification/types";

/**
 * Tenant-scoped asynchronous evidence service.
 *
 * Evidence is append-only through this service: it can be captured and read,
 * but not silently overwritten or deleted. The injected state adapter must
 * enforce tenant scope at the storage boundary. This service is a composition
 * contract; it does not itself make an in-memory adapter durable.
 */
export class AsyncEvidenceService {
  constructor(private readonly state: AsyncHappyStateStore) {}

  async capture(input: EvidenceInput): Promise<Evidence> {
    if (!input.verificationRequestId?.trim()) {
      throw new Error("Verification request ID is required.");
    }
    if (!input.missionId?.trim() || !input.taskId?.trim()) {
      throw new Error("Mission ID and task ID are required.");
    }
    if (!input.title?.trim()) {
      throw new Error("Evidence title is required.");
    }
    if (
      (input.content === undefined || input.content.trim().length === 0) &&
      (input.uri === undefined || input.uri.trim().length === 0)
    ) {
      throw new Error("Evidence content or URI is required.");
    }

    const evidence: Evidence = {
      id: `evidence-${crypto.randomUUID()}`,
      verificationRequestId: input.verificationRequestId.trim(),
      executionRequestId: input.executionRequestId?.trim() || undefined,
      missionId: input.missionId.trim(),
      taskId: input.taskId.trim(),
      type: input.type,
      source: input.source,
      title: input.title.trim(),
      content: input.content?.trim() || undefined,
      uri: input.uri?.trim() || undefined,
      checksum: input.checksum,
      metadata: input.metadata ? structuredClone(input.metadata) : undefined,
      capturedAt: new Date().toISOString(),
      isPrimary: input.isPrimary ?? false,
    };

    // Evidence must attach to an already registered request in the same
    // tenant transaction. Otherwise callers can manufacture orphaned or
    // cross-task evidence records that later appear in audit/recovery views.
    await this.state.transaction(async (transactionState) => {
      const requestRecord = await transactionState
        .verificationRequest<VerificationRequest>()
        .get(evidence.verificationRequestId);
      const request = requestRecord?.data;
      if (!requestRecord ||
          requestRecord.id !== evidence.verificationRequestId ||
          request.id !== evidence.verificationRequestId ||
          request.missionId !== evidence.missionId ||
          request.taskId !== evidence.taskId ||
          (request.executionRequestId || undefined) !==
            (evidence.executionRequestId || undefined)) {
        throw new Error("Evidence must match a registered verification request in the active tenant.");
      }
      await transactionState.evidence<Evidence>().create(evidence.id, evidence);
    });
    return evidence;
  }

  async get(id: string): Promise<Evidence | undefined> {
    const record = await this.state.evidence<Evidence>().get(id);
    return record?.data;
  }

  async forVerification(verificationRequestId: string): Promise<Evidence[]> {
    const normalizedId = verificationRequestId.trim();
    if (!normalizedId) return [];
    const records = await this.state.evidence<Evidence>().list();
    return records
      .map((record) => record.data)
      .filter((evidence) => evidence.verificationRequestId === normalizedId);
  }

  async forTask(taskId: string): Promise<Evidence[]> {
    const normalizedId = taskId.trim();
    if (!normalizedId) return [];
    const records = await this.state.evidence<Evidence>().list();
    return records
      .map((record) => record.data)
      .filter((evidence) => evidence.taskId === normalizedId);
  }

  async count(): Promise<number> {
    return (await this.state.evidence<Evidence>().list()).length;
  }
}
