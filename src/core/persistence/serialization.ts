import type { HappyState } from "./state";

export interface SerializedState {
  schemaVersion: 1;
  savedAt: string;
  state: HappyState;
}

export function serializeState(state: HappyState): string {
  const payload: SerializedState = {
    schemaVersion: 1,
    savedAt: new Date().toISOString(),
    state,
  };

  return JSON.stringify(payload, null, 2);
}

export function deserializeState(input: string): HappyState {
  const parsed: unknown = JSON.parse(input);

  if (
    typeof parsed !== "object" ||
    parsed === null ||
    !("schemaVersion" in parsed) ||
    !("state" in parsed)
  ) {
    throw new Error("Invalid HAPPY persistent state.");
  }

  const payload = parsed as SerializedState;

  if (payload.schemaVersion !== 1) {
    throw new Error(
      `Unsupported persistent state schema: ${String(payload.schemaVersion)}`,
    );
  }

  return payload.state;
}
