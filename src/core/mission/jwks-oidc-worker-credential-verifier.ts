import { createHash, createPublicKey, verify as verifySignature, type JsonWebKey } from "node:crypto";
import type {
  VerifiedWorkerCredentialClaims,
  WorkerCapability,
  WorkerCredentialVerifier,
} from "./trusted-worker-identity";

export interface WorkerJwksResponse {
  ok: boolean;
  status: number;
  json(): Promise<unknown>;
}

export type WorkerJwksFetcher = (url: string) => Promise<WorkerJwksResponse>;

export interface JwksOidcVerifierConfig {
  issuer: string;
  audience: string;
  jwksUri: string;
  /** Server-owned deployment environment; workload subject is independently allowlisted. */
  environment: string;
  /** Server-owned grants for this exact worker deployment, never read from the token. */
  capabilities: readonly WorkerCapability[];
  cacheTtlMs?: number;
  now?: () => number;
}

/**
 * Strict RS256 OIDC/JWKS verifier. It verifies the compact-JWS signature before
 * reading claims, pins issuer/audience, refreshes keys once on an unknown kid,
 * and fails closed on malformed JWKS or network errors.
 *
 * This class deliberately does not fetch credentials from a request header.
 * A separate, platform-controlled credential source must supply the token.
 */
export class JwksOidcWorkerCredentialVerifier implements WorkerCredentialVerifier {
  private cachedKeys: Map<string, JsonWebKey> | null = null;
  private cacheExpiresAt = 0;
  private refreshInFlight: Promise<Map<string, JsonWebKey>> | null = null;

  constructor(
    private readonly config: JwksOidcVerifierConfig,
    private readonly fetcher: WorkerJwksFetcher = (url) => fetch(url),
  ) {}

  async verifyCredential(credential: string): Promise<VerifiedWorkerCredentialClaims | null> {
    try {
      if (
        typeof credential !== "string" || !credential.trim() ||
        !this.config.issuer.trim() || !this.config.audience.trim() ||
        !this.config.jwksUri.trim() || !this.config.environment.trim() ||
        !Array.isArray(this.config.capabilities) || this.config.capabilities.length === 0 ||
        this.config.capabilities.some((capability) =>
          !["API", "BROWSER", "FILE", "DATABASE", "DEPLOY", "PUBLISH", "CONTROL", "VERIFY"].includes(capability)
        )
      ) return null;

      const parts = credential.split(".");
      if (parts.length !== 3 || parts.some((part) => !part)) return null;

      const header = decodeJson(parts[0]);
      if (!header || header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid.trim() ||
          (header.crit !== undefined && (!Array.isArray(header.crit) || header.crit.length > 0)) ||
          header.jku !== undefined || header.x5u !== undefined) return null;

      const keys = await this.getKeys(false);
      let jwk = keys.get(header.kid);
      if (!jwk) {
        const refreshed = await this.getKeys(true);
        jwk = refreshed.get(header.kid);
      }
      if (!jwk || jwk.kty !== "RSA" || jwk.use !== "sig" || (jwk.alg && jwk.alg !== "RS256")) return null;

      const signingInput = Buffer.from(parts[0] + "." + parts[1], "utf8");
      const signature = decodeBase64Url(parts[2]);
      const publicKey = createPublicKey({ key: jwk, format: "jwk" });
      if (!verifySignature("RSA-SHA256", signingInput, publicKey, signature)) return null;

      const payload = decodeJson(parts[1]);
      if (!payload || typeof payload !== "object") return null;
      const nowMs = (this.config.now ?? Date.now)();
      if (!Number.isFinite(nowMs) || nowMs < 0) return null;
      const now = Math.floor(nowMs / 1000);
      const skew = 30;

      const audiences = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
      if (
        payload.iss !== this.config.issuer ||
        audiences.length === 0 ||
        audiences.some((audience) => typeof audience !== "string") ||
        !audiences.includes(this.config.audience) ||
        (audiences.length > 1 && payload.azp !== this.config.audience) ||
        typeof payload.sub !== "string" || !payload.sub.trim() ||
        !isTimestamp(payload.iat) || !isTimestamp(payload.nbf) || !isTimestamp(payload.exp) ||
        payload.iat > now + skew || payload.nbf > now + skew || payload.exp <= now - skew ||
        payload.exp <= payload.iat ||
        (payload.jti !== undefined && (typeof payload.jti !== "string" || !payload.jti.trim()))
      ) return null;

      // jti is preferred. The digest fallback is a stable credential identifier,
      // not a replay-prevention mechanism; replay control belongs in the DB claim.
      const tokenId = typeof payload.jti === "string"
        ? payload.jti
        : createHash("sha256").update(credential).digest("hex");

      return {
        issuer: payload.iss,
        subject: payload.sub,
        audience: audiences as string[],
        issuedAt: payload.iat,
        notBefore: payload.nbf,
        expiresAt: payload.exp,
        tokenId,
        environment: this.config.environment,
        capabilities: [...new Set(this.config.capabilities)],
      };
    } catch {
      return null;
    }
  }

  private async getKeys(forceRefresh: boolean): Promise<Map<string, JsonWebKey>> {
    const now = (this.config.now ?? Date.now)();
    if (!forceRefresh && this.cachedKeys && now < this.cacheExpiresAt) return this.cachedKeys;
    if (this.refreshInFlight) return this.refreshInFlight;

    this.refreshInFlight = (async () => {
      const response = await this.fetcher(this.config.jwksUri);
      if (!response.ok) throw new Error("Worker JWKS fetch failed: " + response.status);
      const body = await response.json();
      if (!body || typeof body !== "object" || !Array.isArray((body as { keys?: unknown }).keys)) {
        throw new Error("Worker JWKS response is malformed");
      }
      const next = new Map<string, JsonWebKey>();
      for (const item of (body as { keys: unknown[] }).keys) {
        if (!item || typeof item !== "object") continue;
        const key = item as JsonWebKey & { kid?: unknown; kty?: unknown; use?: unknown; alg?: unknown };
        if (
          typeof key.kid === "string" && key.kid.trim() &&
          key.kty === "RSA" && key.use === "sig" &&
          (!key.alg || key.alg === "RS256") &&
          typeof key.n === "string" && decodeBase64Url(key.n).length >= 256 &&
          typeof key.e === "string" &&
          (!Array.isArray((key as JsonWebKey & { key_ops?: unknown }).key_ops) ||
            ((key as JsonWebKey & { key_ops: unknown[] }).key_ops.includes("verify")))
        ) {
          if (next.has(key.kid)) throw new Error("Worker JWKS contains duplicate key IDs");
          next.set(key.kid, key);
        }
      }
      if (next.size === 0) throw new Error("Worker JWKS contains no supported signing keys");
      this.cachedKeys = next;
      this.cacheExpiresAt = now + Math.max(1_000, this.config.cacheTtlMs ?? 300_000);
      return next;
    })();

    try {
      return await this.refreshInFlight;
    } finally {
      this.refreshInFlight = null;
    }
  }
}

function decodeBase64Url(value: string): Buffer {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid base64url");
  return Buffer.from(value, "base64url");
}

function decodeJson(value: string): Record<string, unknown> | null {
  const parsed: unknown = JSON.parse(decodeBase64Url(value).toString("utf8"));
  return parsed && typeof parsed === "object" && !Array.isArray(parsed)
    ? parsed as Record<string, unknown>
    : null;
}

function isTimestamp(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}
