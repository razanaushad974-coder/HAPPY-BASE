import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from "node:fs";

import {
  dirname,
  isAbsolute,
  resolve,
} from "node:path";

export type WorkspaceFileOperation =
  | "READ"
  | "CREATE"
  | "MODIFY"
  | "COPY"
  | "MOVE"
  | "RENAME"
  | "DELETE";

export interface WorkspaceFileChange {
  action: "CREATE" | "MODIFY";
  path: string;
  content: string;
  expectedPreviousContentHash?: string;
}

export interface WorkspaceFileOperationRequest {
  action: WorkspaceFileOperation;
  path: string;
  destinationPath?: string;
  content?: string;
  expectedPreviousContentHash?: string;
}

export interface WorkspaceFileOperationResult {
  action: WorkspaceFileOperation;
  status: "COMPLETED" | "BLOCKED" | "FAILED";
  path: string;
  destinationPath?: string;
  content?: string;
  changedFiles: string[];
  errors: string[];
}

export interface WorkspaceExecutionResult {
  status: "COMPLETED" | "BLOCKED" | "FAILED";
  changedFiles: string[];
  errors: string[];
}

function simpleHash(value: string): string {
  let hash = 2166136261;

  for (let i = 0; i < value.length; i++) {
    hash ^= value.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }

  return (hash >>> 0).toString(16);
}

export class WorkspaceCodeExecutor {
  constructor(
    private readonly workspaceRoot: string = process.cwd(),
  ) {}

  private resolveSafePath(relativePath: string): string {
    if (!relativePath || isAbsolute(relativePath)) {
      throw new Error(
        `Only relative workspace paths are allowed: ${relativePath}`,
      );
    }

    const root = resolve(this.workspaceRoot);
    const candidate = resolve(root, relativePath);

    const rootPrefix =
      process.platform === "win32"
        ? `${root}\\`
        : `${root}/`;

    if (
      candidate !== root &&
      !candidate.startsWith(rootPrefix)
    ) {
      throw new Error(
        `Workspace path escapes configured root: ${relativePath}`,
      );
    }

    return candidate;
  }

  execute(
    changes: WorkspaceFileChange[],
  ): WorkspaceExecutionResult {
    const changedFiles: string[] = [];
    const errors: string[] = [];

    if (!Array.isArray(changes) || changes.length === 0) {
      return {
        status: "BLOCKED",
        changedFiles,
        errors: [
          "No approved workspace file changes were supplied.",
        ],
      };
    }

    for (const change of changes) {
      try {
        const result = this.executeOperation({
          action: change.action,
          path: change.path,
          content: change.content,
          expectedPreviousContentHash:
            change.expectedPreviousContentHash,
        });

        if (result.status !== "COMPLETED") {
          errors.push(...result.errors);
          break;
        }

        changedFiles.push(
          ...result.changedFiles,
        );
      } catch (error) {
        errors.push(
          error instanceof Error
            ? error.message
            : String(error),
        );
        break;
      }
    }

    return {
      status:
        errors.length === 0
          ? "COMPLETED"
          : "FAILED",
      changedFiles,
      errors,
    };
  }

  executeOperation(
    request: WorkspaceFileOperationRequest,
  ): WorkspaceFileOperationResult {
    const changedFiles: string[] = [];
    const errors: string[] = [];

    try {
      const source =
        this.resolveSafePath(request.path);

      switch (request.action) {
        case "READ": {
          if (!existsSync(source)) {
            throw new Error(
              `Cannot READ missing file: ${request.path}`,
            );
          }

          const content =
            readFileSync(source, "utf8");

          return {
            action: request.action,
            status: "COMPLETED",
            path: request.path,
            content,
            changedFiles,
            errors,
          };
        }

        case "CREATE": {
          if (existsSync(source)) {
            throw new Error(
              `Cannot CREATE existing file: ${request.path}`,
            );
          }

          if (typeof request.content !== "string") {
            throw new Error(
              "CREATE requires file content.",
            );
          }

          mkdirSync(
            dirname(source),
            { recursive: true },
          );

          writeFileSync(
            source,
            request.content,
            "utf8",
          );

          changedFiles.push(request.path);

          return {
            action: request.action,
            status: "COMPLETED",
            path: request.path,
            changedFiles,
            errors,
          };
        }

        case "MODIFY": {
          if (!existsSync(source)) {
            throw new Error(
              `Cannot MODIFY missing file: ${request.path}`,
            );
          }

          if (typeof request.content !== "string") {
            throw new Error(
              "MODIFY requires file content.",
            );
          }

          if (request.expectedPreviousContentHash) {
            const current =
              readFileSync(source, "utf8");

            const currentHash =
              simpleHash(current);

            if (
              currentHash !==
              request.expectedPreviousContentHash
            ) {
              throw new Error(
                `Previous-content hash mismatch: ${request.path}`,
              );
            }
          }

          writeFileSync(
            source,
            request.content,
            "utf8",
          );

          changedFiles.push(request.path);

          return {
            action: request.action,
            status: "COMPLETED",
            path: request.path,
            changedFiles,
            errors,
          };
        }

        case "COPY": {
          if (!existsSync(source)) {
            throw new Error(
              `Cannot COPY missing source: ${request.path}`,
            );
          }

          if (!request.destinationPath) {
            throw new Error(
              "COPY requires destinationPath.",
            );
          }

          const destination =
            this.resolveSafePath(
              request.destinationPath,
            );

          if (existsSync(destination)) {
            throw new Error(
              `COPY destination already exists: ${request.destinationPath}`,
            );
          }

          mkdirSync(
            dirname(destination),
            { recursive: true },
          );

          copyFileSync(
            source,
            destination,
          );

          changedFiles.push(
            request.destinationPath,
          );

          return {
            action: request.action,
            status: "COMPLETED",
            path: request.path,
            destinationPath:
              request.destinationPath,
            changedFiles,
            errors,
          };
        }

        case "MOVE":
        case "RENAME": {
          if (!existsSync(source)) {
            throw new Error(
              `Cannot ${request.action} missing source: ${request.path}`,
            );
          }

          if (!request.destinationPath) {
            throw new Error(
              `${request.action} requires destinationPath.`,
            );
          }

          const destination =
            this.resolveSafePath(
              request.destinationPath,
            );

          if (existsSync(destination)) {
            throw new Error(
              `${request.action} destination already exists: ${request.destinationPath}`,
            );
          }

          mkdirSync(
            dirname(destination),
            { recursive: true },
          );

          renameSync(
            source,
            destination,
          );

          changedFiles.push(request.path);
          changedFiles.push(
            request.destinationPath,
          );

          return {
            action: request.action,
            status: "COMPLETED",
            path: request.path,
            destinationPath:
              request.destinationPath,
            changedFiles,
            errors,
          };
        }

        case "DELETE": {
          if (!existsSync(source)) {
            throw new Error(
              `Cannot DELETE missing file: ${request.path}`,
            );
          }

          rmSync(source, {
            force: false,
          });

          changedFiles.push(request.path);

          return {
            action: request.action,
            status: "COMPLETED",
            path: request.path,
            changedFiles,
            errors,
          };
        }

        default:
          throw new Error(
            `Unsupported workspace file operation: ${String(request.action)}`,
          );
      }
    } catch (error) {
      errors.push(
        error instanceof Error
          ? error.message
          : String(error),
      );

      return {
        action: request.action,
        status: "FAILED",
        path: request.path,
        destinationPath:
          request.destinationPath,
        changedFiles,
        errors,
      };
    }
  }
}
