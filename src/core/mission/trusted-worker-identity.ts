/**
 * Workload identity boundary for durable execution workers.
 *
 * This module validates claims returned by a cryptographic verifier. It does
 * not parse or verify JWTs itself and deliberately has no HTTP/header/body
 * adapter. Production composition must inject a platform-controlled credential
 * source and a verifier that validates signature, JWKS/key rotation, issuer,
 * audience, expiry, not-before, and revocation before returning claims.
 */
/** Exact execution capabilities plus the worker's control-plane permissions. */
export type WorkerCapability =
  | "CODE" | "FILE" | "API" | "BROWSER" | "SHELL" | "DATABASE" | "AI"
  | "DEPLOYMENT" | "PUBLISH" | "AUTOMATION"
  | "DEPLOY" | "CONTROL" | "VERIFY";

export interface VerifiedWorkerCredentialClaims {
  issuer: string;
  subject: string;
  audience: string | string[];
  issuedAt: number;
  notBefore: number;
  expiresAt: number;
  tokenId: string;
  environment: string;
  capabilities: string[];
}

export interface WorkerCredentialVerifier {
  /** Returns claims only after cryptographic and issuer/audience verification. */
  verifyCredential(credential: string): Promise<VerifiedWorkerCredentialClaims | null>;
}

export interface TrustedWorkerCredentialSource {
  /**
   * Must read credentials from the hosting platform's trusted workload
   * identity channel. Never implement this using request body, query params,
   * ordinary user Authorization headers, or caller-controlled forwarded headers.
   */
  getCredential(): Promise<string | null>;
}

export interface TrustedWorkerIdentityPolicy {
  issuer: string;
  audience: string;
  environment: string;
  allowedSubjects: readonly string[];
  allowedCapabilities: readonly WorkerCapability[];
  maxCredentialLifetimeSeconds: number;
  clockSkewSeconds?: number;
}

const WORKER_IDENTITY_ATTESTATION = Symbol("HAPPY_VERIFIED_WORKER_IDENTITY");

export interface VerifiedWorkerIdentity {
  readonly [WORKER_IDENTITY_ATTESTATION]: true;
  principal: string;
  issuer: string;
  audience: string;
  environment: string;
  tokenId: string;
  issuedAt: number;
  expiresAt: number;
  capabilities: readonly WorkerCapability[];
}

export type WorkerIdentityResolution =
  | { status: "VERIFIED"; identity: VerifiedWorkerIdentity }
  | { status: "NOT_CONNECTED" | "DENIED" };

/**
 * Runtime attestation check for server-side composition. A plain object that
 * copies the public identity fields is not a verified identity.
 */
export function isVerifiedWorkerIdentity(value: unknown): value is VerifiedWorkerIdentity {
  return Boolean(
    value &&
    typeof value === "object" &&
    (value as VerifiedWorkerIdentity)[WORKER_IDENTITY_ATTESTATION] === true
  );
}

const CAPABILITIES = new Set<WorkerCapability>([
  "CODE", "FILE", "API", "BROWSER", "SHELL", "DATABASE", "AI",
  "DEPLOYMENT", "PUBLISH", "AUTOMATION", "DEPLOY", "CONTROL", "VERIFY",
]);

function isFiniteInteger(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

/**
 * Validates a platform-attested workload identity. The credential source and
 * cryptographic verifier are intentionally injected: no provider is selected
 * or enabled by this core contract.
 */
export class TrustedWorkerIdentityProvider {
  constructor(
    private readonly source: TrustedWorkerCredentialSource | null,
    private readonly verifier: WorkerCredentialVerifier | null,
    private readonly policy: TrustedWorkerIdentityPolicy,
    private readonly now: () => number = () => Date.now(),
  ) {}

  async getVerifiedWorkerIdentity(): Promise<WorkerIdentityResolution> {
    if (!this.source || !this.verifier) return { status: "NOT_CONNECTED" };

    try {
      // Runtime configuration is untrusted until validated. Keep every
      // property access inside this boundary so malformed injected config
      // fails closed instead of escaping as an exception.
      const policy = this.policy as TrustedWorkerIdentityPolicy | null;
      if (!policy || typeof policy !== "object") return { status: "DENIED" };

      const issuer = typeof policy.issuer === "string" ? policy.issuer.trim() : "";
      const audience = typeof policy.audience === "string" ? policy.audience.trim() : "";
      const environment = typeof policy.environment === "string" ? policy.environment.trim() : "";
      const subjects = Array.isArray(policy.allowedSubjects) ? policy.allowedSubjects : [];
      const capabilityList = Array.isArray(policy.allowedCapabilities) ? policy.allowedCapabilities : [];
      if (
        subjects.some((value) => typeof value !== "string") ||
        capabilityList.some((value) => typeof value !== "string")
      ) return { status: "DENIED" };

      const allowedSubjects = new Set(subjects.map((value) => value.trim()).filter(Boolean));
      const allowedCapabilities = new Set(capabilityList);
      const maxLifetime = policy.maxCredentialLifetimeSeconds;
      const skew = policy.clockSkewSeconds ?? 30;

      if (
        !issuer || !audience || !environment || allowedSubjects.size === 0 ||
        allowedCapabilities.size === 0 ||
        [...allowedCapabilities].some((capability) => !CAPABILITIES.has(capability as WorkerCapability)) ||
        !Number.isSafeInteger(maxLifetime) || maxLifetime < 1 ||
        !Number.isSafeInteger(skew) || skew < 0 || skew > 120
      ) return { status: "DENIED" };

      const credential = await this.source.getCredential();
      if (typeof credential !== "string" || !credential.trim()) {
        return { status: "DENIED" };
      }

      // The verifier is the cryptographic trust boundary; never decode JWT
      // payloads locally and treat their contents as verified claims.
      const claims = await this.verifier.verifyCredential(credential);
      if (!claims || typeof claims !== "object") return { status: "DENIED" };

      const nowMs = this.now();
      if (!Number.isFinite(nowMs) || nowMs < 0) return { status: "DENIED" };
      const now = Math.floor(nowMs / 1000);
      const audiences = Array.isArray(claims.audience)
        ? claims.audience
        : [claims.audience];
      const capabilities = Array.isArray(claims.capabilities)
        ? claims.capabilities
        : [];

      if (
        typeof claims.issuer !== "string" || claims.issuer !== issuer ||
        audiences.some((value) => typeof value !== "string") ||
        !audiences.includes(audience) ||
        typeof claims.environment !== "string" || claims.environment !== environment ||
        typeof claims.subject !== "string" ||
        claims.subject.startsWith("user:") ||
        !allowedSubjects.has(claims.subject) ||
        typeof claims.tokenId !== "string" || !claims.tokenId.trim() ||
        !isFiniteInteger(claims.issuedAt) ||
        !isFiniteInteger(claims.notBefore) ||
        !isFiniteInteger(claims.expiresAt) ||
        claims.issuedAt > now + skew ||
        claims.notBefore > now + skew ||
        claims.expiresAt <= now - skew ||
        claims.expiresAt <= claims.issuedAt ||
        claims.expiresAt - claims.issuedAt > maxLifetime ||
        capabilities.length === 0 ||
        capabilities.some((value) => typeof value !== "string") ||
        new Set(capabilities).size !== capabilities.length ||
        capabilities.some((capability) =>
          !CAPABILITIES.has(capability as WorkerCapability) ||
          !allowedCapabilities.has(capability as WorkerCapability)
        )
      ) return { status: "DENIED" };

      const identity = {
        principal: claims.subject,
        issuer,
        audience,
        environment,
        tokenId: claims.tokenId,
        issuedAt: claims.issuedAt,
        expiresAt: claims.expiresAt,
        capabilities: Object.freeze([...capabilities]) as readonly WorkerCapability[],
      } as VerifiedWorkerIdentity;
      Object.defineProperty(identity, WORKER_IDENTITY_ATTESTATION, {
        value: true,
        enumerable: false,
        configurable: false,
        writable: false,
      });
      Object.freeze(identity);
      return { status: "VERIFIED", identity };
    } catch {
      // Credential source, verifier, clock, or malformed runtime config
      // failures are authorization failures; never fall back to user identity.
      return { status: "DENIED" };
    }
  }
}
