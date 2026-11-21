import {
  resolveCanonicalTenantContext,
  resolveAuthenticatedTenantContext,
  type CanonicalTenantMembershipStore,
  type OrganizationMembershipRecord,
  type WorkspaceMembershipRecord,
  type VerifiedServerIdentityProvider,
} from "../../../core/tenant/canonical-tenant-context";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const identity = { userId: "verified-user-1" };
  const scope = { organizationId: "org-1", workspaceId: "workspace-1" };
  const org: OrganizationMembershipRecord = {
    userId: "verified-user-1",
    organizationId: "org-1",
    status: "ACTIVE",
    role: "FOUNDER",
  };
  const workspace: WorkspaceMembershipRecord = {
    userId: "verified-user-1",
    organizationId: "org-1",
    workspaceId: "workspace-1",
    status: "ACTIVE",
    role: "ADMIN",
  };

  function store(
    overrides: Partial<{
      organization: OrganizationMembershipRecord | null;
      workspace: WorkspaceMembershipRecord | null;
      failLookup: boolean;
    }> = {},
  ): CanonicalTenantMembershipStore {
    return {
      async getTenantMembershipPair(userId, organizationId, workspaceId) {
        if (overrides.failLookup) throw new Error("membership RPC unavailable");
        if (
          userId !== identity.userId ||
          organizationId !== scope.organizationId ||
          workspaceId !== scope.workspaceId
        ) return null;
        const organization = overrides.organization === undefined ? org : overrides.organization;
        const workspace = overrides.workspace === undefined ? { ...workspaceRecord } : overrides.workspace;
        return organization && workspace ? { organization, workspace } : null;
      },
    };
  }

  const workspaceRecord = workspace;
  const resolved = await resolveCanonicalTenantContext(identity, scope, store());
  assert(resolved !== null, "Valid active membership was rejected.");
  assert(resolved.actor.userId === identity.userId, "Resolved actor did not use verified identity.");
  assert(resolved.actor.organizationIds.length === 1 && resolved.actor.organizationIds[0] === scope.organizationId, "Organization scope was not canonical.");
  assert(resolved.actor.workspaceIds.length === 1 && resolved.actor.workspaceIds[0] === scope.workspaceId, "Workspace scope was not canonical.");
  assert(resolved.organizationRole === "FOUNDER" && resolved.workspaceRole === "ADMIN", "Membership roles were not preserved.");

  assert(await resolveCanonicalTenantContext(null, scope, store()) === null, "Missing verified identity was accepted.");
  assert(await resolveCanonicalTenantContext({ userId: " " }, scope, store()) === null, "Blank verified identity was accepted.");
  assert(await resolveCanonicalTenantContext(identity, { ...scope, workspaceId: "" }, store()) === null, "Blank workspace scope was accepted.");
  assert(await resolveCanonicalTenantContext(identity, scope, store({ organization: null })) === null, "Missing organization membership was accepted.");
  assert(await resolveCanonicalTenantContext(identity, scope, store({ workspace: null })) === null, "Missing workspace membership was accepted.");
  assert(await resolveCanonicalTenantContext(identity, scope, store({ organization: { ...org, status: "SUSPENDED" } })) === null, "Suspended organization membership was accepted.");
  assert(await resolveCanonicalTenantContext(identity, scope, store({ workspace: { ...workspace, status: "REVOKED" } })) === null, "Revoked workspace membership was accepted.");
  assert(await resolveCanonicalTenantContext(identity, scope, store({ organization: { ...org, userId: "attacker" } })) === null, "Mismatched organization member identity was accepted.");
  assert(await resolveCanonicalTenantContext(identity, scope, store({ workspace: { ...workspace, organizationId: "other-org" } })) === null, "Cross-organization workspace membership was accepted.");
  assert(await resolveCanonicalTenantContext(identity, scope, store({ workspace: { ...workspace, workspaceId: "other-workspace" } })) === null, "Mismatched workspace membership was accepted.");
  assert(await resolveCanonicalTenantContext(identity, scope, store({ failLookup: true })) === null, "Membership RPC failure did not fail closed.");

  const verifiedIdentityProvider: VerifiedServerIdentityProvider = {
    async getVerifiedIdentity() { return identity; },
  };
  const authenticated = await resolveAuthenticatedTenantContext(verifiedIdentityProvider, scope, store());
  assert(authenticated.status === "AUTHENTICATED", "Verified server identity was not composed with active tenant membership.");
  if (authenticated.status === "AUTHENTICATED") {
    assert(authenticated.context.actor.userId === "verified-user-1", "Authenticated tenant actor did not come from the verified session.");
  }

  const unauthenticated = await resolveAuthenticatedTenantContext(
    { async getVerifiedIdentity() { return null; } }, scope, store(),
  );
  assert(unauthenticated.status === "UNAUTHENTICATED", "Missing server session did not fail closed.");

  const identityProviderFailure = await resolveAuthenticatedTenantContext(
    { async getVerifiedIdentity() { throw new Error("auth provider unavailable"); } }, scope, store(),
  );
  assert(identityProviderFailure.status === "UNAUTHENTICATED", "Identity provider failure did not fail closed.");

  const tenantDenied = await resolveAuthenticatedTenantContext(
    verifiedIdentityProvider, { ...scope, workspaceId: "attacker-selected-workspace" }, store(),
  );
  assert(tenantDenied.status === "TENANT_ACCESS_DENIED", "Unmatched caller-selected workspace was accepted.");

  console.log("Canonical tenant membership contract: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
