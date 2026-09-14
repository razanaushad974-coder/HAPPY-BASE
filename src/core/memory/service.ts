import { MemoryRepository } from "./repository";
import type {
  CreateMemoryInput,
  HappyMemory,
  MemoryQuery,
} from "./types";

/**
 * Single service boundary for HAPPY memory operations.
 *
 * Higher-level systems should use this service rather than
 * directly manipulating the repository.
 */
export class MemoryService {
  constructor(
    private readonly repository: MemoryRepository = new MemoryRepository(),
  ) {}

  remember(input: CreateMemoryInput): HappyMemory {
    return this.repository.create(input);
  }

  recall(id: string): HappyMemory | undefined {
    return this.repository.get(id);
  }

  search(query: MemoryQuery = {}): HappyMemory[] {
    return this.repository.search(query);
  }

  update(
    id: string,
    patch: Partial<Pick<
      HappyMemory,
      "value" | "confidence" | "expiresAt"
    >>,
  ): HappyMemory {
    return this.repository.update(id, patch);
  }

  forget(id: string): boolean {
    return this.repository.delete(id);
  }

  count(): number {
    return this.repository.count();
  }
}
