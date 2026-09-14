import type {
  FileChunkRecord,
} from "./ingestion-types";

import type {
  HappyFile,
} from "./types";

export class FileChunkManager {
  createChunks(file: HappyFile): FileChunkRecord[] {
    const chunks: FileChunkRecord[] = [];

    if (file.sizeBytes === 0) {
      return chunks;
    }

    for (
      let chunkIndex = 0;
      chunkIndex < file.totalChunks;
      chunkIndex += 1
    ) {
      const offsetBytes =
        chunkIndex * file.chunkSizeBytes;

      const remainingBytes =
        file.sizeBytes - offsetBytes;

      const sizeBytes = Math.min(
        file.chunkSizeBytes,
        remainingBytes,
      );

      chunks.push({
        id: `chunk_${crypto.randomUUID()}`,
        fileId: file.id,
        chunkIndex,
        offsetBytes,
        sizeBytes,
        uploaded: false,
        createdAt: new Date().toISOString(),
      });
    }

    return chunks;
  }

  markUploaded(
    chunk: FileChunkRecord,
  ): FileChunkRecord {
    return {
      ...chunk,
      uploaded: true,
    };
  }

  countUploaded(
    chunks: FileChunkRecord[],
  ): number {
    return chunks.filter(
      (chunk) => chunk.uploaded,
    ).length;
  }

  allUploaded(
    chunks: FileChunkRecord[],
  ): boolean {
    return chunks.every(
      (chunk) => chunk.uploaded,
    );
  }
}
