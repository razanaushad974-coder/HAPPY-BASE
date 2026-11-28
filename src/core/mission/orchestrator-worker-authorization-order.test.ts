import assert from "node:assert/strict";

import type { AsyncTenantPersistenceAdapter } from "../persistence/async-tenant-repository";
import { MissionOrchestrator } from "./orchestrator";
import type { IdempotentDispatchProvider } from "./durable-dispatch-worker-contract";

async function main(): Promise<void> {
  let tenantReads = 0;
  const persistence = {
    async list() {
      tenantReads += 1;
      return [];
    },
  } as unknown as AsyncTenantPersistenceAdapter;

  const provider: IdempotentDispatchProvider = {
    providerId: "unused",
    supportsIdempotencyKeys: true,
    async dispatch() {
      throw new Error("Provider must never be called in this test.");
    },
  };

  const orchestrator = new MissionOrchestrator();
  const result = await orchestrator.runNextReadyMissionTaskDispatch({
    persistence,
    scope: {
      organizationId: "org-1",
      workspaceId: "workspace-1",
      userId: "user-1",
    },
    tenantScope: {
      workerPrincipalId: "worker-1",
      organizationId: "org-1",
      workspaceId: "workspace-1",
      userId: "user-1",
    },
    ownerId: "worker-instance-1",
    leaseMilliseconds: 60_000,
    provider,
  });

  assert.deepEqual(result, {
    status: "NOT_CONNECTED",
    missing: "IDENTITY_PROVIDER",
  });
  assert.equal(tenantReads, 0, "tenant scheduling data must not be read before worker identity authorization");
  console.log("Worker identity authorization precedes tenant task scan: PASS");
}

void main();
