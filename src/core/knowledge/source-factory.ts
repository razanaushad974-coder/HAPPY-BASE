import type {
  KnowledgeSource,
} from "./types";

export function createFileKnowledgeSource(
  fileId: string,
  fileName: string,
): KnowledgeSource {
  const now = new Date().toISOString();

  return {
    id: `ksrc_${crypto.randomUUID()}`,
    sourceType: "FILE",
    sourceId: fileId,
    name: fileName,
    status: "PENDING",
    createdAt: now,
    updatedAt: now,
  };
}
