import type {
  FileKind,
  HappyFile,
} from "./types";

const DEFAULT_CHUNK_SIZE = 8 * 1024 * 1024;

function detectKind(fileName: string): FileKind {
  const extension = fileName
    .toLowerCase()
    .split(".")
    .pop();

  switch (extension) {
    case "pdf":
      return "PDF";

    case "docx":
      return "DOCX";

    case "txt":
      return "TXT";

    case "md":
      return "MD";

    case "json":
      return "JSON";

    case "csv":
      return "CSV";

    case "zip":
      return "ZIP";

    case "png":
    case "jpg":
    case "jpeg":
    case "webp":
      return "IMAGE";

    case "mp4":
    case "mov":
    case "webm":
      return "VIDEO";

    case "mp3":
    case "wav":
    case "m4a":
      return "AUDIO";

    case "ts":
    case "tsx":
    case "js":
    case "jsx":
    case "py":
    case "java":
    case "go":
    case "rs":
    case "sql":
    case "css":
    case "html":
      return "CODE";

    default:
      return "OTHER";
  }
}

export class LargeFileService {
  createFile(
    name: string,
    sizeBytes: number,
    mimeType?: string,
  ): HappyFile {
    if (!name.trim()) {
      throw new Error("File name cannot be empty.");
    }

    if (!Number.isSafeInteger(sizeBytes) || sizeBytes < 0) {
      throw new Error("Invalid file size.");
    }

    const chunkSizeBytes = DEFAULT_CHUNK_SIZE;

    const totalChunks =
      sizeBytes === 0
        ? 0
        : Math.ceil(sizeBytes / chunkSizeBytes);

    const now = new Date().toISOString();

    return {
      id: `file_${crypto.randomUUID()}`,
      name,
      kind: detectKind(name),
      sizeBytes,
      status: "CREATED",
      mimeType,
      uploadedBytes: 0,
      chunkSizeBytes,
      totalChunks,
      uploadedChunks: 0,
      createdAt: now,
      updatedAt: now,
    };
  }

  markUploading(file: HappyFile): HappyFile {
    return {
      ...file,
      status: "UPLOADING",
      updatedAt: new Date().toISOString(),
    };
  }

  markChunkUploaded(
    file: HappyFile,
    chunkSizeBytes: number,
  ): HappyFile {
    const uploadedBytes = Math.min(
      file.sizeBytes,
      file.uploadedBytes + chunkSizeBytes,
    );

    const uploadedChunks = Math.min(
      file.totalChunks,
      file.uploadedChunks + 1,
    );

    return {
      ...file,
      uploadedBytes,
      uploadedChunks,
      status:
        uploadedChunks >= file.totalChunks
          ? "UPLOADED"
          : "UPLOADING",
      updatedAt: new Date().toISOString(),
    };
  }

  markProcessing(file: HappyFile): HappyFile {
    if (
      file.totalChunks > 0 &&
      file.uploadedChunks !== file.totalChunks
    ) {
      throw new Error(
        "Cannot process a file before all chunks are uploaded.",
      );
    }

    return {
      ...file,
      status: "PROCESSING",
      updatedAt: new Date().toISOString(),
    };
  }

  markReady(file: HappyFile): HappyFile {
    return {
      ...file,
      status: "READY",
      updatedAt: new Date().toISOString(),
    };
  }
}
