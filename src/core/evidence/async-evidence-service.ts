import { AsyncTenantScopedRepository } from "../persistence/async-tenant-repository";
import type { Evidence, EvidenceInput } from "./types";

/**
 * Tenant-scoped append-only evidence service.
 *
 * The injected repository must be backed by a storage adapter that enforces
 * organization/workspace/principal scope. This service intentionally exposes
 * no update or delete operation for captured evidence.
 */
export class AsyncEvidenceService {
  constructor(
    private readonly repository: AsyncTenantScopedRepository<Evidence>,
  ) {}

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
    if (input.content === undefined && input.uri === undefined) {
      throw new Error("Evidence content or URI is required.");
    }

    const evidence: Evidence = {
      ...input,
      id: `evidence-${crypto.randomUUID()}`,
      verificationRequestId: input.verificationRequestId.trim(),
      missionId: input.missionId.trim(),
      taskId: input.taskId.trim(),
      title: input.title.trim(),
      capturedAt: new Date().toISOString(),
      isPrimary: input.isPrimary ?? false,
    };
    await this.repository.create(evidence.id, evidence);
    return evidence;
  }

  async get(id: string): Promise<Evidence | undefined> {
    return (await this.repository.get(id))?.data;
  }

  async forVerification(verificationRequestId: string): Promise<Evidence[]> {
    const records = await this.repository.list();
    return records
      .map((record) => record.data)
      .filter((item) => item.verificationRequestId === verificationRequestId);
  }

  async forTask(taskId: string): Promise<Evidence[]> {
    const records = await this.repository.list();
    return records
      .map((record) => record.data)
      .filter((item) => item.taskId === taskId);
  }

  async count(): Promise<number> {
    return (await this.repository.list()).length;
  }
}
