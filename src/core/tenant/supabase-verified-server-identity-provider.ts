import type {
  VerifiedServerIdentityProvider,
  VerifiedTenantIdentity,
} from "./canonical-tenant-context";

/** Minimal shape of Supabase's server-side auth.getUser() response. */
export interface SupabaseVerifiedAuthUser {
  id?: unknown;
}

export interface SupabaseVerifiedAuthResult {
  data?: { user?: SupabaseVerifiedAuthUser | null } | null;
  error?: unknown | null;
}

/**
 * Structural contract for a server-created Supabase client.
 * Implementations must be request-scoped and carry the incoming user's
 * cookies/JWT. Never pass a service-role client or a browser client.
 */
export interface SupabaseServerAuthClient {
  auth: {
    /** Calls Supabase Auth to validate the access token and return its user. */
    getUser(): Promise<SupabaseVerifiedAuthResult>;
  };
}

/**
 * Obtains the principal from Supabase Auth's verified getUser() response.
 * Deliberately does not accept request IDs, JWT payloads, user_metadata,
 * getSession() results, or caller-supplied user IDs as identity evidence.
 */
export class SupabaseVerifiedServerIdentityProvider
implements VerifiedServerIdentityProvider {
  constructor(private readonly client: SupabaseServerAuthClient) {}

  async getVerifiedIdentity(): Promise<VerifiedTenantIdentity | null> {
    try {
      const result = await this.client.auth.getUser();
      if (result.error) return null;
      const id = result.data?.user?.id;
      if (typeof id !== "string" || !id.trim()) return null;
      return { userId: id.trim() };
    } catch {
      // Auth service/network failures are authentication failures.
      return null;
    }
  }
}
