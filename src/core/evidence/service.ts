import type { Evidence, EvidenceInput } from "./types";
import type { EvidenceRepository } from "./repository";

export class EvidenceService {
  constructor(private readonly repository: EvidenceRepository) {}

  capture(input: EvidenceInput): Evidence {
    if (!input.verificationRequestId) {
      throw new Error("Verification request ID is required.");
    }

    if (!input.missionId || !input.taskId) {
      throw new Error("Mission ID and task ID are required.");
    }

    if (!input.title.trim()) {
      throw new Error("Evidence title is required.");
    }

    return this.repository.create(input);
  }

  get(id: string): Evidence | undefined {
    return this.repository.get(id);
  }

  forVerification(verificationRequestId: string): Evidence[] {
    return this.repository.listByVerification(verificationRequestId);
  }

  forTask(taskId: string): Evidence[] {
    return this.repository.listByTask(taskId);
  }
}
