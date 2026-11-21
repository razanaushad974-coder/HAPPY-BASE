import {
  resolveSupabaseRequestTenantContext,
  type RequestScopedSupabaseClient,
} from "@/core/tenant/supabase-request-tenant-composition";
import type {
  AuthenticatedTenantResolution,
  RequestedTenantScope,
} from "@/core/tenant/canonical-tenant-context";

import { createClient } from "./server";

/**
 * Resolve a selected organization/workspace against the current user's
 * Supabase-authenticated request. The selected IDs are selectors only;
 * authoritative membership must be confirmed by the auth.uid()-bound database
 * RPC before a caller may access tenant data.
 *
 * This adapter creates a fresh cookie-bound SSR client for this request.
 * It never uses a service-role key or a browser singleton. If the RPC is absent,
 * inaccessible, or rejects the user, the core resolver returns
 * TENANT_ACCESS_DENIED (fail closed).
 */
export async function resolveCurrentRequestTenantContext(
  requestedScope: RequestedTenantScope,
): Promise<AuthenticatedTenantResolution> {
  return resolveSupabaseRequestTenantContext(
    {
      async createForCurrentRequest() {
        const client = await createClient();
        return client as unknown as RequestScopedSupabaseClient;
      },
    },
    requestedScope,
  );
}
