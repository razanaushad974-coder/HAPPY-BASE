import type {
  FileKind,
  HappyFile,
} from "./types";

import type {
  FileIngestionResult,
} from "./ingestion-types";

import {
  FileChunkManager,
} from "./chunk-manager";

import {
  LocalFileExtractor,
} from "./local-extractor";

export class FileIngestionPipeline {
  private readonly chunks =
    new FileChunkManager();

  private readonly extractor =
    new LocalFileExtractor();

  ingestTextFile(
    file: HappyFile,
    content: string,
  ): FileIngestionResult {
    if (
      file.kind !== "TXT" &&
      file.kind !== "MD" &&
      file.kind !== "JSON" &&
      file.kind !== "CSV" &&
      file.kind !== "CODE"
    ) {
      const extraction =
        this.extractor.extract(
          file.id,
          file.name,
          file.kind,
          content,
        );

      return {
        file,
        chunks: this.chunks.createChunks(file),
        extraction,
      };
    }

    const chunks =
      this.chunks.createChunks(file).map(
        (chunk) => ({
          ...chunk,
          uploaded: true,
        }),
      );

    const extraction =
      this.extractor.extract(
        file.id,
        file.name,
        file.kind,
        content,
      );

    return {
      file: {
        ...file,
        uploadedBytes: file.sizeBytes,
        uploadedChunks: file.totalChunks,
        status: "PROCESSING",
        updatedAt: new Date().toISOString(),
      },
      chunks,
      extraction,
    };
  }

  supportsLocalTextExtraction(
    kind: FileKind,
  ): boolean {
    return (
      kind === "TXT" ||
      kind === "MD" ||
      kind === "JSON" ||
      kind === "CSV" ||
      kind === "CODE"
    );
  }
}
