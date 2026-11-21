import {
  resolveSupabaseRequestTenantContext,
  type RequestScopedSupabaseClient,
} from "../../../core/tenant/supabase-request-tenant-composition";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const rpcCalls: Array<{ functionName: string; args: Record<string, unknown> }> = [];
  let membershipStatus = "ACTIVE";
  const client: RequestScopedSupabaseClient = {
    auth: {
      async getUser() {
        return { data: { user: { id: "verified-user-1" } }, error: null };
      },
    },
    async rpc(functionName, args) {
      rpcCalls.push({ functionName, args });
      return {
        data: [{
          user_id: "verified-user-1",
          organization_id: "org-1",
          workspace_id: "workspace-1",
          organization_role: "FOUNDER",
          workspace_role: "OWNER",
          membership_status: membershipStatus,
        }],
        error: null,
      };
    },
  };

  let factoryCalls = 0;
  const result = await resolveSupabaseRequestTenantContext({
    async createForCurrentRequest() {
      factoryCalls += 1;
      return client;
    },
  }, { organizationId: "org-1", workspaceId: "workspace-1" });

  assert(result.status === "AUTHENTICATED", "Valid request-scoped identity and memberships were denied.");
  if (result.status === "AUTHENTICATED") {
    assert(result.context.actor.userId === "verified-user-1", "Caller identity did not come from auth.getUser().");
    assert(result.context.organizationRole === "FOUNDER", "Organization role was not resolved from membership RPC.");
    assert(result.context.workspaceRole === "OWNER", "Workspace role was not resolved from membership RPC.");
  }
  assert(factoryCalls === 1, "One request must create exactly one Supabase client.");
  assert(rpcCalls.length === 1, "Both memberships must be resolved by one atomic RPC.");
  assert(rpcCalls[0].functionName === "resolve_authenticated_tenant_context", "Unexpected membership RPC.");
  assert(rpcCalls[0].args.p_organization_id === "org-1", "RPC was not bound to the selected organization.");
  assert(rpcCalls[0].args.p_workspace_id === "workspace-1", "RPC was not bound to the exact selected workspace.");
  assert(!("user_id" in rpcCalls[0].args), "Caller-controlled user ID must never be sent to the membership RPC.");

  membershipStatus = "REVOKED";
  const revokedClient: RequestScopedSupabaseClient = {
    ...client,
    async rpc(functionName, args) {
      return {
        data: [{
          user_id: "verified-user-1",
          organization_id: "org-1",
          workspace_id: "workspace-1",
          organization_role: "FOUNDER",
          workspace_role: "OWNER",
        }],
        error: null,
      };
    },
  };
  const revoked = await resolveSupabaseRequestTenantContext({
    async createForCurrentRequest() { return revokedClient; },
  }, { organizationId: "org-1", workspaceId: "workspace-1" });
  assert(revoked.status === "AUTHENTICATED", "The RPC must return no row, rather than a client-supplied membership status, for revoked membership.");

  const mismatchedPrincipal: RequestScopedSupabaseClient = {
    ...client,
    async rpc() {
      return {
        data: [{
          user_id: "attacker-user",
          organization_id: "org-1",
          workspace_id: "workspace-1",
          organization_role: "FOUNDER",
          workspace_role: "OWNER",
        }],
        error: null,
      };
    },
  };
  const mismatch = await resolveSupabaseRequestTenantContext({
    async createForCurrentRequest() { return mismatchedPrincipal; },
  }, { organizationId: "org-1", workspaceId: "workspace-1" });
  assert(mismatch.status === "TENANT_ACCESS_DENIED", "RPC result for a different user was accepted.");

  const unavailable = await resolveSupabaseRequestTenantContext({
    async createForCurrentRequest() { throw new Error("request context unavailable"); },
  }, { organizationId: "org-1", workspaceId: "workspace-1" });
  assert(unavailable.status === "UNAUTHENTICATED", "Request-client factory failure did not fail closed.");

  const rpcFailure: RequestScopedSupabaseClient = {
    ...client,
    async rpc() { return { data: null, error: { message: "function unavailable" } }; },
  };
  const denied = await resolveSupabaseRequestTenantContext({
    async createForCurrentRequest() { return rpcFailure; },
  }, { organizationId: "org-1", workspaceId: "workspace-1" });
  assert(denied.status === "TENANT_ACCESS_DENIED", "Membership RPC failure did not fail closed.");

  console.log("Supabase request tenant composition contract: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
