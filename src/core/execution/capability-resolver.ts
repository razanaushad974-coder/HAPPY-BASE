import type { ExecutionCapability } from "./types";
import type { ResolvedReference } from "../context/types";

export type ExecutionAction =
  | "UNDERSTAND"
  | "RESEARCH"
  | "CREATE"
  | "MODIFY"
  | "BUILD"
  | "TEST"
  | "VERIFY"
  | "DEPLOY"
  | "PUBLISH"
  | "AUTOMATE"
  | "CONTROL";

export function resolveExecutionCapability(
  action: ExecutionAction | string,
  targetReference?: ResolvedReference,
): ExecutionCapability {
  if (
    targetReference?.entityType === "FILE" &&
    (
      action === "CREATE" ||
      action === "MODIFY"
    )
  ) {
    return "FILE";
  }

  switch (action) {
    case "UNDERSTAND":
    case "RESEARCH":
    case "VERIFY":
    case "CONTROL":
      return "AI";

    case "CREATE":
    case "MODIFY":
    case "BUILD":
    case "TEST":
      return "CODE";

    case "DEPLOY":
      return "DEPLOYMENT";

    case "PUBLISH":
      return "PUBLISH";

    case "AUTOMATE":
      return "AUTOMATION";

    default:
      return "AI";
  }
}
