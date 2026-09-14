/**
 * HAPPY Large File Foundation
 *
 * This layer describes files independently from their
 * physical storage provider.
 *
 * Large uploads must use chunked/resumable processing.
 *
 * IMPORTANT:
 * A 5 GB file is never required to exist completely
 * in application memory.
 */

export type FileStatus =
  | "CREATED"
  | "UPLOADING"
  | "PAUSED"
  | "UPLOADED"
  | "PROCESSING"
  | "READY"
  | "FAILED"
  | "DELETED";

export type FileKind =
  | "PDF"
  | "DOCX"
  | "TXT"
  | "MD"
  | "JSON"
  | "CSV"
  | "CODE"
  | "IMAGE"
  | "VIDEO"
  | "AUDIO"
  | "ZIP"
  | "OTHER";

export interface HappyFile {
  id: string;

  name: string;

  kind: FileKind;

  sizeBytes: number;

  status: FileStatus;

  mimeType?: string;

  checksum?: string;

  uploadedBytes: number;

  chunkSizeBytes: number;

  totalChunks: number;

  uploadedChunks: number;

  createdAt: string;

  updatedAt: string;
}

export interface FileChunk {
  fileId: string;

  chunkIndex: number;

  offsetBytes: number;

  sizeBytes: number;

  checksum?: string;

  uploaded: boolean;
}

export interface FileUploadSession {
  id: string;

  fileId: string;

  status:
    | "ACTIVE"
    | "PAUSED"
    | "COMPLETED"
    | "FAILED";

  createdAt: string;

  updatedAt: string;
}
