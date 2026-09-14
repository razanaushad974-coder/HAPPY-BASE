import { LargeFileService } from "@/core/files/service";
import { FileChunkManager } from "@/core/files/chunk-manager";
import { FileIngestionPipeline } from "@/core/files/ingestion-pipeline";

function main(): void {
  const files = new LargeFileService();

  const content = [
    "# HAPPY Master Requirements",
    "",
    "Feature: Founder Dashboard",
    "HAPPY must understand founder commands.",
    "HAPPY must support API creation.",
    "Security: authentication and permission controls are required.",
    "Database storage is required.",
    "UI: Founder Dashboard screen.",
  ].join("\n");

  const file = files.createFile(
    "happy-master.md",
    Buffer.byteLength(content, "utf8"),
    "text/markdown",
  );

  if (file.kind !== "MD") {
    throw new Error(
      `Expected MD, received ${file.kind}.`,
    );
  }

  const chunkManager = new FileChunkManager();

  const chunks =
    chunkManager.createChunks(file);

  if (chunks.length !== 1) {
    throw new Error(
      `Expected one physical chunk for small test file, received ${chunks.length}.`,
    );
  }

  if (chunks[0].sizeBytes !== file.sizeBytes) {
    throw new Error(
      "Chunk size does not match source file size.",
    );
  }

  const pipeline =
    new FileIngestionPipeline();

  const result =
    pipeline.ingestTextFile(
      file,
      content,
    );

  if (result.extraction.status !== "READY") {
    throw new Error(
      "Markdown extraction did not complete.",
    );
  }

  if (
    result.extraction.text !== content
  ) {
    throw new Error(
      "Extracted content differs from source.",
    );
  }

  if (
    result.file.uploadedBytes !==
    result.file.sizeBytes
  ) {
    throw new Error(
      "Ingestion did not account for uploaded bytes.",
    );
  }

  console.log("File ingestion test: PASS");

  console.log({
    fileKind: file.kind,
    extractionStatus:
      result.extraction.status,
    characters:
      result.extraction.characterCount,
    chunks: result.chunks.length,
    uploadedBytes:
      result.file.uploadedBytes,
  });
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
