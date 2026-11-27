import assert from "node:assert/strict";
import { runNodeWorkerBatch } from "./node-worker-scheduler";
import { TrustedWorkerIdentityProvider } from "./trusted-worker-identity";
import type { WorkerDatabaseBroker } from "./worker-database-broker";
import type { WorkerRuntimeCompositionDependencies } from "./worker-runtime-composition";

async function main(): Promise<void> {
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
  
  
  const fixedNow = 1_800_000_000_000;
  const verifiedIdentityProvider = new TrustedWorkerIdentityProvider(
    { async getCredential() { return "test-signed-workload-credential"; } },
    {
      async verifyCredential() {
        return {
          issuer: "https://identity.example.test",
          subject: "node-worker:staging",
          audience: "happy-worker",
          issuedAt: 1_799_999_990,
          notBefore: 1_799_999_990,
          expiresAt: 1_800_000_060,
          tokenId: "test-token-1",
          environment: "staging",
          capabilities: ["CONTROL"],
        };
      },
    },
    {
      issuer: "https://identity.example.test",
      audience: "happy-worker",
      environment: "staging",
      allowedSubjects: ["node-worker:staging"],
      allowedCapabilities: ["CONTROL"],
      maxCredentialLifetimeSeconds: 120,
    },
    () => fixedNow,
  );
  const authorizedDependencies: WorkerRuntimeCompositionDependencies = {
    identityProvider: verifiedIdentityProvider,
    principalRegistry: {
      async findByIssuerSubjectEnvironment() {
        return {
          principalId: "worker-principal-staging",
          issuer: "https://identity.example.test",
          subject: "node-worker:staging",
          audience: "happy-worker",
          environment: "staging",
          enabled: true,
          capabilities: ["CONTROL"],
          revokedAt: null,
        };
      },
    },
    databaseBroker: {} as WorkerDatabaseBroker,
  };
  let readyTaskCalls = 0;
  const authorizedWorker = {
    async runOneReadyTask(input: { scope: { organizationId: string; workspaceId: string; userId: string }; workerScope: { workerPrincipalId: string; organizationId: string; workspaceId: string; userId: string } }) {
      readyTaskCalls += 1;
      assert.equal(input.scope.organizationId, "org-1");
      assert.equal(input.workerScope.workerPrincipalId, "worker-principal-staging");
      return { status: "NO_READY_TASK" };
    },
  } as unknown as Parameters<typeof runNodeWorkerBatch>[0]["worker"];
  const successfulBatch = await runNodeWorkerBatch({
    dependencies: authorizedDependencies,
    tenantScopeSource: {
      async nextAuthorizedTenant({ identity, registration, cursor }) {
        assert.equal(identity.principal, "node-worker:staging");
        assert.equal(registration.principalId, "worker-principal-staging");
        assert.equal(cursor, null);
        return {
          scope: { organizationId: "org-1", workspaceId: "workspace-1", userId: "user-1" },
          workerScope: {
            workerPrincipalId: "worker-principal-staging",
            organizationId: "org-1",
            workspaceId: "workspace-1",
            userId: "user-1",
          },
          nextCursor: null,
        };
      },
    },
    worker: authorizedWorker,
    operation: "READY_TASK",
    maxTenants: 1,
  });
  assert.equal(successfulBatch.status, "COMPLETED");
  assert.equal(successfulBatch.tenantsVisited, 1);
  assert.equal(readyTaskCalls, 1, "one authorized tenant must receive exactly one bounded operation");
  
  const midScanController = new AbortController();
  let cancelledWorkerCalls = 0;
  const cancelledBatch = await runNodeWorkerBatch({
    dependencies: authorizedDependencies,
    tenantScopeSource: {
      async nextAuthorizedTenant() {
        midScanController.abort();
        return {
          scope: { organizationId: "org-1", workspaceId: "workspace-1", userId: "user-1" },
          workerScope: {
            workerPrincipalId: "worker-principal-staging",
            organizationId: "org-1",
            workspaceId: "workspace-1",
            userId: "user-1",
          },
          nextCursor: "cursor-1",
        };
      },
    },
    worker: {
      async runOneReadyTask() {
        cancelledWorkerCalls += 1;
        return { status: "SHOULD_NOT_RUN" };
      },
    } as unknown as Parameters<typeof runNodeWorkerBatch>[0]["worker"],
    operation: "READY_TASK",
    maxTenants: 1,
    signal: midScanController.signal,
  });
  assert.equal(cancelledBatch.status, "STOPPED");
  assert.equal(cancelledBatch.tenantsVisited, 0);
  assert.equal(cancelledWorkerCalls, 0, "cancellation during grant resolution must prevent task execution");
  
  console.log("Bounded Node worker scheduler: PASS");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
