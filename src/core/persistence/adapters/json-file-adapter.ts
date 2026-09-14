import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import type { HappyState } from "../state";
import {
  createEmptyState,
} from "../state";
import {
  deserializeState,
  serializeState,
} from "../serialization";

export interface PersistentStateAdapter {
  load(): HappyState;
  save(state: HappyState): void;
}

export class JsonFileStateAdapter implements PersistentStateAdapter {
  constructor(private readonly filePath: string) {}

  load(): HappyState {
    if (!existsSync(this.filePath)) {
      return createEmptyState();
    }

    const raw = readFileSync(this.filePath, "utf8");

    return deserializeState(raw);
  }

  save(state: HappyState): void {
    mkdirSync(dirname(this.filePath), { recursive: true });

    const serialized = serializeState(state);

    writeFileSync(
      this.filePath,
      serialized,
      "utf8",
    );
  }
}
