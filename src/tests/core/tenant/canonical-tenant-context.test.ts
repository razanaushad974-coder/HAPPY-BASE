import {
  resolveCanonicalTenantContext,
  type CanonicalTenantMembershipStore,
  type OrganizationMembershipRecord,
  type WorkspaceMembershipRecord,
} from "../../../core/tenant/canonical-tenant-context";

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  const identity = { userId: "verified-user-1" };
  const scope = { organizationId: "org-1", workspaceId: "workspace-1" };
  const org: OrganizationMembershipRecord = {
    userId: "verified-user-1",
    organizationId: "org-1",
    status: "ACTIVE" as const,
    role: "FOUNDER",
  };
  const workspace: WorkspaceMembershipRecord = {
    userId: "verified-user-1",
    organizationId: "org-1",
    workspaceId: "workspace-1",
    status: "ACTIVE" as const,
    role: "ADMIN",
  };

  function store(
    overrides: Partial<{
      organization: OrganizationMembershipRecord | null;
      workspace: WorkspaceMembershipRecord | null;
      failOrganization: boolean;
      failWorkspace: boolean;
    }> = {},
  ): CanonicalTenantMembershipStore {
    return {
      async getOrganizationMembership(userId, organizationId) {
        if (overrides.failOrganization) throw new Error("membership store unavailable");
        if (userId !== identity.userId || organizationId !== scope.organizationId) return null;
        return overrides.organization === undefined ? org : overrides.organization;
      },
      async getWorkspaceMembership(userId, organizationId, workspaceId) {
        if (overrides.failWorkspace) throw new Error("membership store unavailable");
        if (
          userId !== identity.userId ||
          organizationId !== scope.organizationId ||
          workspaceId !== scope.workspaceId
        ) return null;
        return overrides.workspace === undefined ? workspace : overrides.workspace;
      },
    };
  }

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
  assert(await resolveCanonicalTenantContext(identity, scope, store({ failOrganization: true })) === null, "Organization store failure did not fail closed.");
  assert(await resolveCanonicalTenantContext(identity, scope, store({ failWorkspace: true })) === null, "Workspace store failure did not fail closed.");

  console.log("Canonical tenant membership contract: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
