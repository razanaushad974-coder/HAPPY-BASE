import type {
  KnowledgeChunk,
} from "./types";

const DEFAULT_CHARS_PER_CHUNK = 4000;

/**
 * Knowledge chunker.
 *
 * Important:
 * - Never intentionally splits a line when possible.
 * - Preserves complete requirement lines.
 * - Falls back to hard character boundaries only when
 *   one individual line itself exceeds the limit.
 */
export class KnowledgeChunker {
  chunk(
    sourceId: string,
    text: string,
    charsPerChunk = DEFAULT_CHARS_PER_CHUNK,
  ): KnowledgeChunk[] {
    if (charsPerChunk <= 0) {
      throw new Error(
        "charsPerChunk must be greater than zero.",
      );
    }

    if (!text) {
      return [];
    }

    const lines = text.split(/\r?\n/);

    const chunks: KnowledgeChunk[] = [];

    let current = "";
    let currentStart = 0;
    let position = 0;
    let chunkIndex = 0;

    const pushChunk = (
      content: string,
      startOffset: number,
    ): void => {
      if (!content) {
        return;
      }

      chunks.push({
        id: `kchunk_${crypto.randomUUID()}`,
        sourceId,
        chunkIndex,
        content,
        tokenEstimate: Math.ceil(
          content.length / 4,
        ),
        metadata: {
          startOffset: String(startOffset),
          endOffset: String(
            startOffset + content.length,
          ),
        },
      });

      chunkIndex += 1;
    };

    for (const line of lines) {
      const lineWithNewline =
        line + "\n";

      /*
       * If one line is itself larger than the target,
       * flush the existing chunk and hard-split that
       * individual line.
       */
      if (
        lineWithNewline.length >
          charsPerChunk
      ) {
        if (current) {
          pushChunk(
            current,
            currentStart,
          );

          current = "";
        }

        for (
          let offset = 0;
          offset < lineWithNewline.length;
          offset += charsPerChunk
        ) {
          pushChunk(
            lineWithNewline.slice(
              offset,
              offset + charsPerChunk,
            ),
            position + offset,
          );
        }

        position +=
          lineWithNewline.length;

        currentStart = position;
        continue;
      }

      if (
        current.length > 0 &&
        current.length +
          lineWithNewline.length >
          charsPerChunk
      ) {
        pushChunk(
          current,
          currentStart,
        );

        current = "";
        currentStart = position;
      }

      if (!current) {
        currentStart = position;
      }

      current += lineWithNewline;
      position += lineWithNewline.length;
    }

    if (current) {
      pushChunk(
        current,
        currentStart,
      );
    }

    return chunks;
  }
}
