import type { Evidence, EvidenceInput } from "./types";

export interface EvidenceRepository {
  create(input: EvidenceInput): Evidence;
  get(id: string): Evidence | undefined;
  listByVerification(verificationRequestId: string): Evidence[];
  listByTask(taskId: string): Evidence[];
  count(): number;
}

export class InMemoryEvidenceRepository implements EvidenceRepository {
  private readonly records = new Map<string, Evidence>();

  create(input: EvidenceInput): Evidence {
    const id = `evidence-${crypto.randomUUID()}`;

    const evidence: Evidence = {
      id,
      verificationRequestId: input.verificationRequestId,
      executionRequestId: input.executionRequestId,
      missionId: input.missionId,
      taskId: input.taskId,
      type: input.type,
      source: input.source,
      title: input.title,
      content: input.content,
      uri: input.uri,
      checksum: input.checksum,
      metadata: input.metadata,
      capturedAt: new Date().toISOString(),
      isPrimary: input.isPrimary ?? false,
    };

    this.records.set(id, evidence);
    return evidence;
  }

  get(id: string): Evidence | undefined {
    return this.records.get(id);
  }

  listByVerification(verificationRequestId: string): Evidence[] {
    return [...this.records.values()].filter(
      (item) => item.verificationRequestId === verificationRequestId,
    );
  }

  listByTask(taskId: string): Evidence[] {
    return [...this.records.values()].filter(
      (item) => item.taskId === taskId,
    );
  }

  count(): number {
    return this.records.size;
  }
}

