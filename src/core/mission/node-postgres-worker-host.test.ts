import assert from "node:assert/strict";
import type { PgPoolLike } from "../persistence/adapters/postgres-tenant-adapter";
import type { AsyncTenantPersistenceAdapter } from "../persistence/async-tenant-repository";
import { runNodePostgresWorkerHost } from "./node-postgres-worker-host";
import type { NodeWorkerShutdownSignal } from "./node-worker-process";

async function main(): Promise<void> {
  const listeners = new Map<NodeWorkerShutdownSignal, () => void>();
  let poolClosed = 0;
  let poolConnections = 0;
  const pool: PgPoolLike = {
    async connect() {
      poolConnections += 1;
      throw new Error("A NOT_CONNECTED identity must fail before PostgreSQL access.");
    },
  };
  const result = await runNodePostgresWorkerHost({
    runtime: {
      identityProvider: {
        async getVerifiedWorkerIdentity() {
          return { status: "NOT_CONNECTED" };
        },
      },
      pool,
      expectedLoginRole: "happy_worker_staging",
    },
    poolLifecycle: {
      async end() {
        poolClosed += 1;
      },
    },
    signals: {
      on(signal, listener) { listeners.set(signal, listener); },
      off(signal, listener) {
        if (listeners.get(signal) === listener) listeners.delete(signal);
      },
    },
    tenantPersistence: {} as unknown as AsyncTenantPersistenceAdapter,
    provider: {
      providerId: "host-entrypoint-test",
      supportsIdempotencyKeys: true,
      async dispatch() {
        return {
          kind: "ACKNOWLEDGED",
          provider: "host-entrypoint-test",
          providerRequestId: "not-used",
          response: {},
        };
      },
    },
    operation: "READY_TASK",
    maxTenants: 2,
  });

  assert.equal(result.batch.status, "NOT_CONNECTED");
  assert.equal(result.batch.tenantsVisited, 0);
  assert.equal(result.shutdownSignal, null);
  assert.equal(poolConnections, 0, "unverified identity must fail before opening PostgreSQL");
  assert.equal(poolClosed, 1, "the host lifecycle must close the pool after the bounded run");
  assert.equal(listeners.size, 0, "shutdown listeners must be removed");
  console.log("Node PostgreSQL worker host entrypoint: PASS");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
