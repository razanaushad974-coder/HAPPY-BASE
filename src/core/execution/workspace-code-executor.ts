import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, resolve } from "node:path";

export interface WorkspaceFileChange {
  action: "CREATE" | "MODIFY";
  path: string;
  content: string;
  expectedPreviousContentHash?: string;
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
        if (!change.path || isAbsolute(change.path)) {
          throw new Error(
            `Only relative workspace paths are allowed: ${change.path}`,
          );
        }

        const target = this.resolveSafePath(change.path);

        if (
          change.action === "MODIFY" &&
          !existsSync(target)
        ) {
          throw new Error(
            `Cannot MODIFY missing file: ${change.path}`,
          );
        }

        if (
          change.action === "CREATE" &&
          existsSync(target)
        ) {
          throw new Error(
            `Cannot CREATE existing file: ${change.path}`,
          );
        }

        if (
          change.action === "MODIFY" &&
          change.expectedPreviousContentHash
        ) {
          const current = readFileSync(target, "utf8");
          const currentHash = simpleHash(current);

          if (
            currentHash !==
            change.expectedPreviousContentHash
          ) {
            throw new Error(
              `Previous-content hash mismatch: ${change.path}`,
            );
          }
        }

        mkdirSync(
          dirname(target),
          { recursive: true },
        );

        writeFileSync(
          target,
          change.content,
          "utf8",
        );

        changedFiles.push(change.path);
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
}
