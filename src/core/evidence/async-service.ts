import type { AsyncHappyStateStore } from "../state/async-happy-state-store";
import type { Evidence, EvidenceInput } from "./types";

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

    const evidence: Evidence = {
      id: `evidence-${crypto.randomUUID()}`,
      verificationRequestId: input.verificationRequestId,
      executionRequestId: input.executionRequestId,
      missionId: input.missionId,
      taskId: input.taskId,
      type: input.type,
      source: input.source,
      title: input.title.trim(),
      content: input.content,
      uri: input.uri,
      checksum: input.checksum,
      metadata: input.metadata ? structuredClone(input.metadata) : undefined,
      capturedAt: new Date().toISOString(),
      isPrimary: input.isPrimary ?? false,
    };

    await this.state.evidence<Evidence>().create(evidence.id, evidence);
    return evidence;
  }

  async get(id: string): Promise<Evidence | undefined> {
    const record = await this.state.evidence<Evidence>().get(id);
    return record?.data;
  }

  async forVerification(verificationRequestId: string): Promise<Evidence[]> {
    const records = await this.state.evidence<Evidence>().list();
    return records
      .map((record) => record.data)
      .filter((evidence) => evidence.verificationRequestId === verificationRequestId);
  }

  async forTask(taskId: string): Promise<Evidence[]> {
    const records = await this.state.evidence<Evidence>().list();
    return records
      .map((record) => record.data)
      .filter((evidence) => evidence.taskId === taskId);
  }

  async count(): Promise<number> {
    return (await this.state.evidence<Evidence>().list()).length;
  }
}
