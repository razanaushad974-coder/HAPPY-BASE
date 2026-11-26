import type { Evidence } from "../evidence/types";
import type { TenantScope } from "../state/types";
import type { VerificationRequest } from "./types";
import type { SignedSemanticAttestation } from "./semantic-attestation";

export interface ExternalSemanticVerifierInput {
  readonly scope: TenantScope & { readonly userId: string };
  readonly request: VerificationRequest;
  readonly evidence: readonly Evidence[];
}

export interface ExternalSemanticVerifierClient {
  evaluate(input: ExternalSemanticVerifierInput): Promise<SignedSemanticAttestation>;
}

export interface ExternalSemanticVerifierClientOptions {
  readonly endpoint: string;
  readonly readBearerToken: () => Promise<string>;
  readonly fetchImpl?: typeof fetch;
  readonly timeoutMilliseconds?: number;
  readonly maxEvidenceItems?: number;
  readonly maxEvidenceContentCharacters?: number;
  readonly maxResponseBytes?: number;
}

/**
 * Calls one operator-configured HTTPS verifier endpoint. This client only
 * transports a bounded, tenant-scoped evaluation request and parses the
 * signed envelope; AsyncVerificationService remains responsible for
 * cryptographic verification and persistence.
 */
export class HttpExternalSemanticVerifierClient implements ExternalSemanticVerifierClient {
  private readonly endpoint: URL;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMilliseconds: number;
  private readonly maxEvidenceItems: number;
  private readonly maxEvidenceContentCharacters: number;
  private readonly maxResponseBytes: number;

  constructor(private readonly options: ExternalSemanticVerifierClientOptions) {
    let endpoint: URL;
    try {
      endpoint = new URL(options.endpoint);
    } catch {
      throw new Error("SEMANTIC_VERIFIER_ENDPOINT_INVALID");
    }
    if (endpoint.protocol !== "https:" || endpoint.username || endpoint.password ||
        endpoint.hash || endpoint.search || endpoint.hostname === "localhost" ||
        endpoint.hostname.endsWith(".localhost")) {
      throw new Error("SEMANTIC_VERIFIER_ENDPOINT_MUST_BE_FIXED_HTTPS");
    }
    this.endpoint = endpoint;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.timeoutMilliseconds = options.timeoutMilliseconds ?? 10_000;
    this.maxEvidenceItems = options.maxEvidenceItems ?? 50;
    this.maxEvidenceContentCharacters = options.maxEvidenceContentCharacters ?? 16_384;
    this.maxResponseBytes = options.maxResponseBytes ?? 256 * 1024;
    if (!Number.isSafeInteger(this.timeoutMilliseconds) ||
        this.timeoutMilliseconds < 1_000 || this.timeoutMilliseconds > 30_000 ||
        !Number.isSafeInteger(this.maxEvidenceItems) ||
        this.maxEvidenceItems < 1 || this.maxEvidenceItems > 100 ||
        !Number.isSafeInteger(this.maxEvidenceContentCharacters) ||
        this.maxEvidenceContentCharacters < 1 || this.maxEvidenceContentCharacters > 65_536 ||
        !Number.isSafeInteger(this.maxResponseBytes) ||
        this.maxResponseBytes < 1_024 || this.maxResponseBytes > 1_048_576) {
      throw new Error("SEMANTIC_VERIFIER_CLIENT_LIMIT_INVALID");
    }
  }

  async evaluate(input: ExternalSemanticVerifierInput): Promise<SignedSemanticAttestation> {
    const { scope, request, evidence } = input;
    if (!scope.organizationId?.trim() || !scope.workspaceId?.trim() ||
        !scope.userId?.trim() || !request.id?.trim() ||
        !Array.isArray(evidence) || evidence.length === 0 ||
        evidence.length > this.maxEvidenceItems) {
      throw new Error("SEMANTIC_VERIFIER_INPUT_INVALID");
    }

    const seen = new Set<string>();
    const boundedEvidence = evidence.map((item) => {
      if (!item.id?.trim() || seen.has(item.id) ||
          item.verificationRequestId !== request.id ||
          item.missionId !== request.missionId ||
          item.taskId !== request.taskId ||
          (item.executionRequestId || undefined) !== (request.executionRequestId || undefined)) {
        throw new Error("SEMANTIC_VERIFIER_EVIDENCE_BINDING_INVALID");
      }
      seen.add(item.id);
      const content = item.content ?? "";
      if (content.length > this.maxEvidenceContentCharacters) {
        throw new Error("SEMANTIC_VERIFIER_EVIDENCE_TOO_LARGE");
      }
      // Deliberately omit evidence URI and arbitrary metadata: neither is
      // required for semantic evaluation and both may contain credentials.
      return {
        id: item.id,
        type: item.type,
        source: item.source,
        title: item.title,
        content,
        checksum: item.checksum ?? null,
        capturedAt: item.capturedAt,
      };
    });

    const token = await this.options.readBearerToken();
    if (typeof token !== "string" || !token.trim() || token.length > 8_192 ||
        /\s/.test(token.trim())) {
      throw new Error("SEMANTIC_VERIFIER_AUTH_TOKEN_INVALID");
    }

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), this.timeoutMilliseconds);
    try {
      const response = await this.fetchImpl(this.endpoint, {
        method: "POST",
        redirect: "error",
        signal: controller.signal,
        headers: {
          authorization: `Bearer ${token.trim()}`,
          "content-type": "application/json",
          accept: "application/json",
          "idempotency-key": request.id,
        },
        body: JSON.stringify({
          schemaVersion: 1,
          scope: {
            organizationId: scope.organizationId,
            workspaceId: scope.workspaceId,
            userId: scope.userId,
          },
          request: {
            id: request.id,
            missionId: request.missionId,
            taskId: request.taskId,
            executionRequestId: request.executionRequestId ?? null,
            description: request.description,
            criteria: request.criteria,
            preferredMethods: request.preferredMethods,
            requiresEvidence: request.requiresEvidence,
          },
          evidence: boundedEvidence,
        }),
      });
      if (!response.ok) {
        throw new Error(`SEMANTIC_VERIFIER_HTTP_${response.status}`);
      }
      const contentType = response.headers.get("content-type") ?? "";
      if (!contentType.toLowerCase().includes("application/json")) {
        throw new Error("SEMANTIC_VERIFIER_RESPONSE_CONTENT_TYPE_INVALID");
      }
      const declaredLength = Number(response.headers.get("content-length") ?? "0");
      if (Number.isFinite(declaredLength) && declaredLength > this.maxResponseBytes) {
        throw new Error("SEMANTIC_VERIFIER_RESPONSE_TOO_LARGE");
      }
      const body = await response.text();
      if (new TextEncoder().encode(body).byteLength > this.maxResponseBytes) {
        throw new Error("SEMANTIC_VERIFIER_RESPONSE_TOO_LARGE");
      }
      let parsed: unknown;
      try {
        parsed = JSON.parse(body);
      } catch {
        throw new Error("SEMANTIC_VERIFIER_RESPONSE_INVALID_JSON");
      }
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        throw new Error("SEMANTIC_VERIFIER_RESPONSE_INVALID");
      }
      const envelope = parsed as Record<string, unknown>;
      if (!envelope.payload || typeof envelope.payload !== "object" ||
          Array.isArray(envelope.payload) ||
          typeof envelope.signature !== "string" || !envelope.signature.trim() ||
          envelope.signature.length > 16_384) {
        throw new Error("SEMANTIC_VERIFIER_SIGNED_ENVELOPE_INVALID");
      }
      return {
        payload: envelope.payload as SignedSemanticAttestation["payload"],
        signature: envelope.signature,
      };
    } finally {
      clearTimeout(timeout);
    }
  }
}
