import { LargeFileService } from "@/core/files/service";

function main(): void {
  const service = new LargeFileService();

  // Exactly 5 GiB.
  const fiveGiB = 5 * 1024 * 1024 * 1024;

  let file = service.createFile(
    "HAPPY-MASTER-SPECIFICATION.pdf",
    fiveGiB,
    "application/pdf",
  );

  if (file.sizeBytes !== fiveGiB) {
    throw new Error("5 GiB file size was not represented correctly.");
  }

  if (file.kind !== "PDF") {
    throw new Error(
      `Expected PDF kind, received ${file.kind}.`,
    );
  }

  if (file.totalChunks <= 1) {
    throw new Error(
      "5 GiB file must be represented as multiple chunks.",
    );
  }

  if (file.uploadedBytes !== 0) {
    throw new Error(
      "New file must start with zero uploaded bytes.",
    );
  }

  file = service.markUploading(file);

  if (file.status !== "UPLOADING") {
    throw new Error("File did not enter UPLOADING state.");
  }

  const firstChunk = Math.min(
    file.chunkSizeBytes,
    file.sizeBytes,
  );

  file = service.markChunkUploaded(
    file,
    firstChunk,
  );

  if (file.uploadedChunks !== 1) {
    throw new Error(
      "First uploaded chunk was not recorded.",
    );
  }

  if (file.uploadedBytes !== firstChunk) {
    throw new Error(
      "Uploaded byte count is incorrect.",
    );
  }

  console.log("Large file test: PASS");

  console.log({
    sizeGiB: file.sizeBytes / (1024 * 1024 * 1024),
    chunkSizeMiB:
      file.chunkSizeBytes / (1024 * 1024),
    totalChunks: file.totalChunks,
    firstChunkRecorded: true,
    resumableStateRepresented: true,
  });
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
