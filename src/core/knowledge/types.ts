/**
 * HAPPY Knowledge Ingestion Foundation
 *
 * Files are sources.
 * Knowledge is derived from sources.
 *
 * This contract deliberately separates:
 *
 * SOURCE FILE
 *     ↓
 * EXTRACTION
 *     ↓
 * CHUNKS
 *     ↓
 * KNOWLEDGE
 *
 * Actual parsers/vector databases/providers are attached later.
 */

export type KnowledgeSourceType =
  | "FILE"
  | "COMMAND"
  | "CONVERSATION"
  | "PROJECT"
  | "SYSTEM";

export type KnowledgeStatus =
  | "PENDING"
  | "EXTRACTING"
  | "INDEXING"
  | "READY"
  | "FAILED";

export interface KnowledgeSource {
  id: string;

  sourceType: KnowledgeSourceType;

  sourceId: string;

  name: string;

  status: KnowledgeStatus;

  createdAt: string;

  updatedAt: string;
}

export interface KnowledgeChunk {
  id: string;

  sourceId: string;

  chunkIndex: number;

  content: string;

  tokenEstimate?: number;

  metadata?: Record<string, string>;
}
