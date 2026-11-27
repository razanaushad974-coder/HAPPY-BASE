import assert from "node:assert/strict";
import { runNodeWorkerBatch } from "./node-worker-scheduler";
import type { WorkerRuntimeCompositionDependencies } from "./worker-runtime-composition";

let scans = 0;
const dependencies: WorkerRuntimeCompositionDependencies = {
  identityProvider: null,
  principalRegistry: null,
  databaseBroker: null,
};
const worker = {} as Parameters<typeof runNodeWorkerBatch>[0]["worker"];
const tenantScopeSource = {
  async nextAuthorizedTenant() {
    scans += 1;
    return null;
  },
};

await assert.rejects(
  () => runNodeWorkerBatch({
    dependencies,
    tenantScopeSource,
    worker,
    operation: "READY_TASK",
    maxTenants: 0,
  }),
  /maxTenants must be between 1 and 20/,
);

const controller = new AbortController();
controller.abort();
const stopped = await runNodeWorkerBatch({
  dependencies,
  tenantScopeSource,
  worker,
  operation: "PENDING_DISPATCH",
  maxTenants: 3,
  signal: controller.signal,
});
assert.equal(stopped.status, "STOPPED");
assert.equal(stopped.tenantsVisited, 0);
assert.equal(scans, 0, "an already-aborted batch must not resolve or scan tenant grants");

const unavailable = await runNodeWorkerBatch({
  dependencies,
  tenantScopeSource,
  worker,
  operation: "READY_TASK",
  maxTenants: 2,
});
assert.equal(unavailable.status, "NOT_CONNECTED");
assert.equal(unavailable.reason, "IDENTITY_PROVIDER");
assert.equal(scans, 0, "missing trusted identity must fail before tenant grant scanning");

console.log("Bounded Node worker scheduler: PASS");
