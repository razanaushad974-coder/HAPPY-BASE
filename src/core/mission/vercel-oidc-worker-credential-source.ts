import type { TrustedWorkerCredentialSource } from "./trusted-worker-identity";

/**
 * Adapter for Vercel's official @vercel/oidc getVercelOidcToken() helper.
 *
 * Compose this as:
 *   new VercelOidcWorkerCredentialSource(getVercelOidcToken)
 *
 * The helper reads the Vercel request-context OIDC token (or the documented
 * development/build token source). It must be called for every identity
 * resolution: Vercel tokens rotate and must never be cached by this adapter.
 * No request body, query parameter, user Authorization header, or forwarded
 * application header is accepted here.
 */
export type VercelOidcTokenReader = () => Promise<string>;

export class VercelOidcWorkerCredentialSource implements TrustedWorkerCredentialSource {
  constructor(private readonly readToken: VercelOidcTokenReader) {}

  async getCredential(): Promise<string | null> {
    try {
      const token = await this.readToken();
      return typeof token === "string" && token.trim().length > 0
        ? token
        : null;
    } catch {
      // Missing request context, unavailable platform token, and SDK failures
      // are all authorization failures. Never substitute caller input.
      return null;
    }
  }
}
