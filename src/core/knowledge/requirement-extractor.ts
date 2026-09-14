import type {
  ExtractedRequirement,
  RequirementExtractionResult,
  RequirementType,
} from "./requirements";

function classify(text: string): RequirementType {
  const value = text.toLowerCase();

  if (
    value.includes("security") ||
    value.includes("permission") ||
    value.includes("authentication") ||
    value.includes("auth")
  ) {
    return "SECURITY";
  }

  if (
    value.includes("database") ||
    value.includes("schema") ||
    value.includes("table") ||
    value.includes("storage")
  ) {
    return "DATA";
  }

  if (
    value.includes("api") ||
    value.includes("webhook") ||
    value.includes("integration")
  ) {
    return "INTEGRATION";
  }

  if (
    value.includes("ui") ||
    value.includes("dashboard") ||
    value.includes("screen") ||
    value.includes("page")
  ) {
    return "UI";
  }

  if (
    value.includes("must") ||
    value.includes("shall") ||
    value.includes("required") ||
    value.includes("requirement")
  ) {
    return "FUNCTIONAL";
  }

  return "UNKNOWN";
}

export class RequirementExtractor {
  extract(
    sourceId: string,
    chunks: Array<{
      id: string;
      content: string;
    }>,
  ): RequirementExtractionResult {
    const requirements: ExtractedRequirement[] = [];

    for (const chunk of chunks) {
      const lines = chunk.content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean);

      for (const line of lines) {
        const normalized = line
          .replace(/^[-*]\s*/, "")
          .replace(/^\d+[.)]\s*/, "")
          .trim();

        if (!normalized) {
          continue;
        }

        const lower = normalized.toLowerCase();

        const looksLikeRequirement =
          lower.includes("must ") ||
          lower.includes("shall ") ||
          lower.includes("should ") ||
          lower.includes("required") ||
          lower.includes("requirement") ||
          lower.startsWith("feature:") ||
          lower.startsWith("module:");

        if (!looksLikeRequirement) {
          continue;
        }

        requirements.push({
          id: `req_${crypto.randomUUID()}`,
          sourceId,
          type: classify(normalized),
          text: normalized,
          confidence: "MEDIUM",
          sourceChunkId: chunk.id,
        });
      }
    }

    return {
      sourceId,
      requirements,
      status:
        requirements.length > 0
          ? "READY"
          : "NO_REQUIREMENTS_FOUND",
    };
  }
}
