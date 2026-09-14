import type {
  VerificationRequest,
  VerificationResult,
} from "./types";
import { VerificationEngine } from "./engine";

export class VerificationOrchestrator {
  constructor(private readonly engine: VerificationEngine) {}

  verify(
    request: VerificationRequest,
    evidenceIds: string[],
  ): VerificationResult {
    return this.engine.verify(request, evidenceIds);
  }
}
