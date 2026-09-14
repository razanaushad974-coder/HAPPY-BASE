import { KnowledgeChunker } from "@/core/knowledge/chunker";
import { RequirementExtractor } from "@/core/knowledge/requirement-extractor";

function main(): void {
  const sourceId = "test_source";

  const text = [
    "# HAPPY",
    "Feature: Founder Dashboard",
    "HAPPY must understand founder commands.",
    "HAPPY must create APIs.",
    "Security authentication is required.",
    "Database storage is required.",
    "UI: Founder Dashboard.",
  ].join("\n");

  const chunker = new KnowledgeChunker();

  /*
   * Deliberately use a small chunk size so the test
   * exercises chunk boundaries.
   */
  const chunks = chunker.chunk(
    sourceId,
    text,
    80,
  );

  if (chunks.length < 2) {
    throw new Error(
      "Knowledge chunker did not split the test content.",
    );
  }

  for (const chunk of chunks) {
    if (!chunk.id.startsWith("kchunk_")) {
      throw new Error(
        "Knowledge chunk ID is invalid.",
      );
    }

    if (chunk.sourceId !== sourceId) {
      throw new Error(
        "Knowledge chunk source ID is incorrect.",
      );
    }

    if (!chunk.content) {
      throw new Error(
        "Knowledge chunk contains empty content.",
      );
    }
  }

  /*
   * Verify requirement lines are not silently
   * destroyed by normal chunk boundaries.
   */
  const reconstructed = chunks
    .map((chunk) => chunk.content)
    .join("");

  if (reconstructed !== text + "\n") {
    throw new Error(
      "Knowledge chunk reconstruction does not preserve source content.",
    );
  }

  const extractor =
    new RequirementExtractor();

  const result =
    extractor.extract(
      sourceId,
      chunks,
    );

  if (
    result.status !== "READY"
  ) {
    throw new Error(
      "Requirement extraction did not find requirements.",
    );
  }

  if (
    result.requirements.length < 5
  ) {
    throw new Error(
      `Expected at least 5 extracted requirements, received ${result.requirements.length}.`,
    );
  }

  const hasFounder =
    result.requirements.some(
      (item) =>
        item.text
          .toLowerCase()
          .includes("founder dashboard"),
    );

  const hasSecurity =
    result.requirements.some(
      (item) => item.type === "SECURITY",
    );

  const hasData =
    result.requirements.some(
      (item) => item.type === "DATA",
    );

  const hasIntegration =
    result.requirements.some(
      (item) => item.type === "INTEGRATION",
    );

  const hasUI =
    result.requirements.some(
      (item) => item.type === "UI",
    );

  if (!hasFounder) {
    throw new Error(
      "Founder Dashboard requirement was not preserved.",
    );
  }

  if (!hasSecurity) {
    throw new Error(
      "Security requirement classification failed.",
    );
  }

  if (!hasData) {
    throw new Error(
      "Data requirement classification failed.",
    );
  }

  if (!hasIntegration) {
    throw new Error(
      "Integration requirement classification failed.",
    );
  }

  if (!hasUI) {
    throw new Error(
      "UI requirement classification failed.",
    );
  }

  console.log("Knowledge engine test: PASS");

  console.log({
    chunks: chunks.length,
    requirements:
      result.requirements.length,
    founderDetected: hasFounder,
    securityDetected: hasSecurity,
    dataDetected: hasData,
    integrationDetected:
      hasIntegration,
    uiDetected: hasUI,
    sourcePreserved:
      reconstructed === text + "\n",
  });
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
