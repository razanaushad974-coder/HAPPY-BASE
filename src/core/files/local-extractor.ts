import type {
  FileKind,
} from "./types";

import type {
  ExtractedFileContent,
} from "./ingestion-types";

/**
 * Safe local extraction foundation.
 *
 * Plain-text formats are extracted directly.
 * Binary formats that require specialized parsers remain
 * explicitly NOT_YET_CONNECTED.
 */

export class LocalFileExtractor {
  extract(
    fileId: string,
    fileName: string,
    kind: FileKind,
    content: string | Uint8Array,
  ): ExtractedFileContent {
    const now = new Date().toISOString();

    if (
      kind !== "TXT" &&
      kind !== "MD" &&
      kind !== "JSON" &&
      kind !== "CSV" &&
      kind !== "CODE"
    ) {
      return {
        fileId,
        fileName,
        kind,
        status: "NOT_YET_CONNECTED",
        text: "",
        characterCount: 0,
        createdAt: now,
      };
    }

    const text =
      typeof content === "string"
        ? content
        : new TextDecoder().decode(content);

    return {
      fileId,
      fileName,
      kind,
      status: "READY",
      text,
      characterCount: text.length,
      createdAt: now,
    };
  }
}
