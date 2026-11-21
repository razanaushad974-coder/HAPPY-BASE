import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  NotConnectedTenantWorkspaceProvisioner,
  resolveTenantWorkspaceExecutor,
  type TenantWorkspaceProvisioner,
} from "../../../core/execution/tenant-workspace-provisioner";
import { WorkspaceCodeExecutor } from "../../../core/execution/workspace-code-executor";
import type { CanonicalTenantContext } from "../../../core/tenant/canonical-tenant-context";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const context: CanonicalTenantContext = {
  actor: { userId: "user-1", organizationIds: ["org-1"], workspaceIds: ["workspace-1"] },
  organizationId: "org-1",
  workspaceId: "workspace-1",
  organizationRole: "FOUNDER",
  workspaceRole: "OWNER",
};

async function main(): Promise<void> {
  const disconnected = await resolveTenantWorkspaceExecutor(
    context,
    new NotConnectedTenantWorkspaceProvisioner(),
  );
  assert(disconnected.status === "NOT_YET_CONNECTED", "Unconfigured workspace storage must remain disconnected.");

  let provisionCalls = 0;
  const invalidContext = await resolveTenantWorkspaceExecutor(
    { ...context, workspaceId: " " },
    {
      async provision() {
        provisionCalls += 1;
        return { status: "NOT_YET_CONNECTED", reason: "unexpected" };
      },
    },
  );
  assert(invalidContext.status === "NOT_YET_CONNECTED", "Incomplete tenant context must not provision a workspace.");
  assert(provisionCalls === 0, "Provisioner was called before canonical tenant context validation.");

  const root = mkdtempSync(join(tmpdir(), "happy-tenant-workspace-"));
  try {
    const executor = new WorkspaceCodeExecutor(root);
    const crossTenant: TenantWorkspaceProvisioner = {
      async provision() {
        return {
          status: "PROVISIONED",
          binding: { userId: "user-2", organizationId: "org-1", workspaceId: "workspace-1" },
          executor,
          storage: "ISOLATED_PERSISTENT_VOLUME",
        };
      },
    };
    const mismatch = await resolveTenantWorkspaceExecutor(context, crossTenant);
    assert(mismatch.status === "NOT_YET_CONNECTED", "A provider binding for another user must be rejected.");

    const valid: TenantWorkspaceProvisioner = {
      async provision(received) {
        assert(received === context, "Provisioner must receive the verified canonical context.");
        return {
          status: "PROVISIONED",
          binding: { userId: "user-1", organizationId: "org-1", workspaceId: "workspace-1" },
          executor,
          storage: "ISOLATED_PERSISTENT_VOLUME",
        };
      },
    };
    const available = await resolveTenantWorkspaceExecutor(context, valid);
    assert(available.status === "AVAILABLE", "An exact tenant-bound provisioned executor was rejected.");
    if (available.status === "AVAILABLE") {
      assert(available.executor === executor, "Resolved executor differs from the provider's tenant-bound executor.");
    }

    const failed = await resolveTenantWorkspaceExecutor(context, {
      async provision() { throw new Error("storage unavailable"); },
    });
    assert(failed.status === "NOT_YET_CONNECTED", "Provider errors must fail closed.");
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  console.log("Tenant workspace provisioner contract: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
