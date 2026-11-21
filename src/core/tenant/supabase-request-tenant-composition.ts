import {
  resolveAuthenticatedTenantContext,
  type AuthenticatedTenantResolution,
  type RequestedTenantScope,
  type VerifiedServerIdentityProvider,
} from "./canonical-tenant-context";
import {
  SupabaseVerifiedServerIdentityProvider,
  type SupabaseServerAuthClient,
} from "./supabase-verified-server-identity-provider";
import {
  SupabaseCanonicalTenantMembershipStore,
  type SupabaseTenantContextRpcClient,
} from "./supabase-private-tenant-stores";

/**
 * A single Supabase client created for the current server request.
 *
 * The factory must bind the current request's cookies/access token and use
 * only the public/anon key. It must never return a service-role client,
 * browser singleton, or client cached across requests.
 */
export type RequestScopedSupabaseClient =
  SupabaseServerAuthClient & SupabaseTenantContextRpcClient;

export interface RequestScopedSupabaseClientFactory {
  createForCurrentRequest(): Promise<RequestScopedSupabaseClient>;
}

/**
 * Resolve the caller and exact tenant membership using one request-scoped
 * client instance. No user ID is accepted from the request; auth.getUser()
 * supplies the principal, and the membership RPC derives the same principal
 * independently from auth.uid() on the user's JWT-bound client.
 *
 * This is the core composition boundary. A Next.js adapter must implement
 * the factory with cookies() from next/headers and a user-scoped Supabase
 * server client. Do not pass a service-role client.
 */
export async function resolveSupabaseRequestTenantContext(
  factory: RequestScopedSupabaseClientFactory,
  requestedScope: RequestedTenantScope,
): Promise<AuthenticatedTenantResolution> {
  let client: RequestScopedSupabaseClient;
  try {
    client = await factory.createForCurrentRequest();
  } catch {
    return { status: "UNAUTHENTICATED" };
  }

  if (!client || !client.auth || typeof client.auth.getUser !== "function" ||
      typeof client.rpc !== "function") {
    return { status: "UNAUTHENTICATED" };
  }

  const identities: VerifiedServerIdentityProvider =
    new SupabaseVerifiedServerIdentityProvider(client);
  const memberships = new SupabaseCanonicalTenantMembershipStore(client);

  return resolveAuthenticatedTenantContext(
    identities,
    requestedScope,
    memberships,
  );
}
