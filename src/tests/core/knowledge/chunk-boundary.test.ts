import { KnowledgeChunker } from "@/core/knowledge/chunker";

function main(): void {
  const sourceId = "boundary_test";

  const lines = [
    "Feature: Founder Dashboard",
    "HAPPY must understand commands.",
    "Database storage is required.",
    "Security authentication is required.",
    "API integration is required.",
  ];

  const source = lines.join("\n");

  const chunker = new KnowledgeChunker();

  const chunks = chunker.chunk(
    sourceId,
    source,
    40,
  );

  const reconstructed = chunks
    .map((chunk) => chunk.content)
    .join("");

  if (reconstructed !== source + "\n") {
    throw new Error(
      "Chunk boundary regression: source was not preserved.",
    );
  }

  for (const line of lines) {
    if (
      !chunks.some(
        (chunk) =>
          chunk.content.includes(line),
      )
    ) {
      throw new Error(
        `Requirement line was split or lost: ${line}`,
      );
    }
  }

  console.log(
    "Chunk boundary regression: PASS",
  );

  console.log({
    chunks: chunks.length,
    sourcePreserved:
      reconstructed === source + "\n",
    linesPreserved: lines.every(
      (line) =>
        chunks.some(
          (chunk) =>
            chunk.content.includes(line),
        ),
    ),
  });
}

try {
  main();
} catch (error) {
  console.error(error);
  process.exit(1);
}
