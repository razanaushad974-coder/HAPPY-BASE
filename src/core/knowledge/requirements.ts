export type RequirementType =
  | "FEATURE"
  | "FUNCTIONAL"
  | "TECHNICAL"
  | "SECURITY"
  | "UI"
  | "DATA"
  | "INTEGRATION"
  | "BUSINESS"
  | "CONSTRAINT"
  | "UNKNOWN";

export interface ExtractedRequirement {
  id: string;

  sourceId: string;

  type: RequirementType;

  text: string;

  confidence:
    | "HIGH"
    | "MEDIUM"
    | "LOW";

  sourceChunkId?: string;
}

export interface RequirementExtractionResult {
  sourceId: string;

  requirements: ExtractedRequirement[];

  status:
    | "READY"
    | "NO_REQUIREMENTS_FOUND"
    | "NOT_YET_CONNECTED";
}
