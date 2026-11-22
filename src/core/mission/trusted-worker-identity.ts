/**
 * Workload identity boundary for durable execution workers.
 *
 * This module validates claims returned by a cryptographic verifier. It does
 * not parse or verify JWTs itself and deliberately has no HTTP/header/body
 * adapter. Production composition must inject a platform-controlled credential
 * source and a verifier that validates signature, JWKS/key rotation, issuer,
 * audience, expiry, not-before, and revocation before returning claims.
 */
export type WorkerCapability =
  | "API" | "BROWSER" | "FILE" | "DATABASE" | "DEPLOY" | "PUBLISH"
  | "CONTROL" | "VERIFY";

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

export interface VerifiedWorkerIdentity {
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

const CAPABILITIES = new Set<WorkerCapability>([
  "API", "BROWSER", "FILE", "DATABASE", "DEPLOY", "PUBLISH",
  "CONTROL", "VERIFY",
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

    const issuer = this.policy.issuer.trim();
    const audience = this.policy.audience.trim();
    const environment = this.policy.environment.trim();
    const allowedSubjects = new Set(this.policy.allowedSubjects.map((value) => value.trim()).filter(Boolean));
    const allowedCapabilities = new Set(this.policy.allowedCapabilities);
    const maxLifetime = this.policy.maxCredentialLifetimeSeconds;
    const skew = this.policy.clockSkewSeconds ?? 30;

    if (
      !issuer || !audience || !environment || allowedSubjects.size === 0 ||
      allowedCapabilities.size === 0 ||
      [...allowedCapabilities].some((capability) => !CAPABILITIES.has(capability)) ||
      !Number.isSafeInteger(maxLifetime) || maxLifetime < 1 ||
      !Number.isSafeInteger(skew) || skew < 0 || skew > 120
    ) return { status: "DENIED" };

    try {
      const credential = await this.source.getCredential();
      if (typeof credential !== "string" || !credential.trim()) {
        return { status: "DENIED" };
      }

      // The verifier is the cryptographic trust boundary; never decode JWT
      // payloads locally and treat their contents as verified claims.
      const claims = await this.verifier.verifyCredential(credential);
      if (!claims) return { status: "DENIED" };

      const now = Math.floor(this.now() / 1000);
      const audiences = Array.isArray(claims.audience)
        ? claims.audience
        : [claims.audience];
      const capabilities = Array.isArray(claims.capabilities)
        ? claims.capabilities
        : [];

      if (
        claims.issuer !== issuer ||
        !audiences.includes(audience) ||
        claims.environment !== environment ||
        typeof claims.subject !== "string" ||
        !claims.subject.startsWith("workload:") ||
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
        new Set(capabilities).size !== capabilities.length ||
        capabilities.some((capability) =>
          !CAPABILITIES.has(capability as WorkerCapability) ||
          !allowedCapabilities.has(capability as WorkerCapability)
        )
      ) return { status: "DENIED" };

      return {
        status: "VERIFIED",
        identity: {
          principal: claims.subject,
          issuer,
          audience,
          environment,
          tokenId: claims.tokenId,
          issuedAt: claims.issuedAt,
          expiresAt: claims.expiresAt,
          capabilities: capabilities as WorkerCapability[],
        },
      };
    } catch {
      // Credential source/verifier outages fail closed; no user-session fallback.
      return { status: "DENIED" };
    }
  }
}
