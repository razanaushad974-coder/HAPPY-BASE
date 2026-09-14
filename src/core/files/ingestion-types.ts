/**
 * HAPPY File Ingestion Contracts
 *
 * Pipeline:
 *
 * SOURCE FILE
 *   -> REGISTRATION
 *   -> CHUNKING
 *   -> EXTRACTION
 *   -> KNOWLEDGE CHUNKS
 *   -> REQUIREMENTS
 *
 * No external provider is assumed.
 */

import type { FileKind, HappyFile } from "./types";

export type ExtractionStatus =
  | "PENDING"
  | "PROCESSING"
  | "READY"
  | "FAILED"
  | "NOT_YET_CONNECTED";

export interface FileChunkRecord {
  id: string;

  fileId: string;

  chunkIndex: number;

  offsetBytes: number;

  sizeBytes: number;

  uploaded: boolean;

  createdAt: string;
}

export interface ExtractedFileContent {
  fileId: string;

  fileName: string;

  kind: FileKind;

  status: ExtractionStatus;

  text: string;

  characterCount: number;

  createdAt: string;
}

export interface FileIngestionResult {
  file: HappyFile;

  chunks: FileChunkRecord[];

  extraction: ExtractedFileContent;
}
