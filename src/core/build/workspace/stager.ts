import type {
  BuildFileChange,
} from "../types";

export interface StagedChange {
  changeId: string;
  path: string;
  action: BuildFileChange["action"];
  content?: string;
  stagedAt: string;
}

export class WorkspaceChangeStager {
  private readonly changes =
    new Map<string, StagedChange>();

  stage(
    change: BuildFileChange,
  ): StagedChange {
    const staged: StagedChange = {
      changeId: change.id,
      path: change.path,
      action: change.action,
      content: change.content,
      stagedAt:
        new Date().toISOString(),
    };

    this.changes.set(
      change.id,
      staged,
    );

    return staged;
  }

  get(
    changeId: string,
  ): StagedChange | undefined {
    return this.changes.get(changeId);
  }

  list(): StagedChange[] {
    return Array.from(
      this.changes.values(),
    );
  }

  clear(): void {
    this.changes.clear();
  }
}
