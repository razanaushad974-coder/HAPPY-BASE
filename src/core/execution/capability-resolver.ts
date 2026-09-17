import type { ExecutionCapability } from "./types";
import type { ResolvedReference } from "../context/types";

export type ExecutionAction =
  | "UNDERSTAND"
  | "RESEARCH"
  | "CREATE"
  | "MODIFY"
  | "BUILD"
  | "TEST"
  | "REQUEST"
  | "CALL"
  | "GET"
  | "POST"
  | "PUT"
  | "PATCH"
  | "DELETE"
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
    case "REQUEST":
    case "CALL":
    case "GET":
    case "POST":
    case "PUT":
    case "PATCH":
    case "DELETE":
      return "API";

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

    case "DB_SELECT":
    case "DB_QUERY":
    case "DB_INSERT":
    case "DB_UPDATE":
    case "DB_DELETE":
    case "DB_TRANSACTION":
      return "DATABASE";

    default:
      return "AI";
  }
}
