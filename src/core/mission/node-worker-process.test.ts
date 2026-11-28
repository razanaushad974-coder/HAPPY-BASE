import assert from "node:assert/strict";
import {
  runNodeWorkerDaemon,
  runNodeWorkerProcess,
  type NodeWorkerShutdownSignal,
} from "./node-worker-process";

async function main(): Promise<void> {
  const listeners = new Map<NodeWorkerShutdownSignal, () => void>();
  let removed = 0;
  let poolClosed = 0;
  let batchSettled = false;
  const signals = {
    on(signal: NodeWorkerShutdownSignal, listener: () => void) {
      listeners.set(signal, listener);
    },
    off(signal: NodeWorkerShutdownSignal, listener: () => void) {
      if (listeners.get(signal) === listener) {
        listeners.delete(signal);
        removed += 1;
      }
    },
  };
  const result = await runNodeWorkerProcess({
    signals,
    pool: {
      async end() {
        assert.equal(batchSettled, true, "pool must remain open until the batch settles");
        poolClosed += 1;
      },
    },
    async runBatch(signal) {
      assert.equal(listeners.size, 2, "both shutdown handlers must be registered");
      listeners.get("SIGTERM")?.();
      assert.equal(signal.aborted, true);
      await Promise.resolve();
      batchSettled = true;
      return {
        status: "STOPPED",
        operation: "READY_TASK",
        tenantsVisited: 0,
        results: [],
      };
    },
  });
  assert.equal(result.shutdownSignal, "SIGTERM");
  assert.equal(result.batch.status, "STOPPED");
  assert.equal(poolClosed, 1);
  assert.equal(removed, 2);
  assert.equal(listeners.size, 0);
  
  let errorPoolClosed = 0;
  await assert.rejects(
    () => runNodeWorkerProcess({
      signals: {
        on() {},
        off() {},
      },
      pool: {
        async end() { errorPoolClosed += 1; },
      },
      async runBatch() {
        throw new Error("batch failure");
      },
    }),
    /batch failure/,
  );
  assert.equal(errorPoolClosed, 1, "pool must close even when batch execution fails");
  
  let registrationFailurePoolClosed = 0;
  let firstListenerRemoved = 0;
  await assert.rejects(
    () => runNodeWorkerProcess({
      signals: {
        on(signal, listener) {
          if (signal === "SIGTERM") throw new Error("signal registration failed");
          listeners.set(signal, listener);
        },
        off(signal, listener) {
          if (listeners.get(signal) === listener) {
            listeners.delete(signal);
            firstListenerRemoved += 1;
          }
        },
      },
      pool: {
        async end() { registrationFailurePoolClosed += 1; },
      },
      async runBatch() {
        throw new Error("batch must not start after signal registration failure");
      },
    }),
    /signal registration failed/,
  );
  assert.equal(registrationFailurePoolClosed, 1, "pool must close when signal registration partially fails");
  assert.equal(firstListenerRemoved, 1, "any listener registered before failure must be removed");
  assert.equal(listeners.has("SIGINT"), false);

  const daemonListeners = new Map<NodeWorkerShutdownSignal, () => void>();
  let daemonCalls = 0;
  let daemonPoolClosed = 0;
  let daemonRemoved = 0;
  const daemonResult = await runNodeWorkerDaemon({
    signals: {
      on(signal, listener) { daemonListeners.set(signal, listener); },
      off(signal, listener) {
        if (daemonListeners.get(signal) === listener) {
          daemonListeners.delete(signal);
          daemonRemoved += 1;
        }
      },
    },
    pool: {
      async end() {
        daemonPoolClosed += 1;
        assert.equal(daemonListeners.size, 0, "daemon listeners must be removed before pool shutdown");
      },
    },
    maxBatches: 5,
    pollIntervalMs: 100,
    async runBatch(signal) {
      daemonCalls += 1;
      assert.equal(signal.aborted, false);
      if (daemonCalls === 2) {
        daemonListeners.get("SIGTERM")?.();
        assert.equal(signal.aborted, true, "SIGTERM must abort the active daemon session");
        return {
          status: "STOPPED",
          operation: "PENDING_DISPATCH",
          tenantsVisited: 1,
          results: [],
        };
      }
      return {
        status: "COMPLETED",
        operation: "PENDING_DISPATCH",
        tenantsVisited: 1,
        results: [],
      };
    },
  });
  assert.equal(daemonResult.status, "STOPPED");
  assert.equal(daemonResult.shutdownSignal, "SIGTERM");
  assert.equal(daemonResult.batchesRun, 2, "daemon must run sequential batches until shutdown");
  assert.equal(daemonResult.tenantsVisited, 2);
  assert.equal(daemonCalls, 2, "daemon must not start a new batch after shutdown");
  assert.equal(daemonPoolClosed, 1, "daemon must close the shared pool exactly once");
  assert.equal(daemonRemoved, 2, "daemon must remove both shutdown listeners");
  assert.equal(daemonListeners.size, 0);

  let deniedBatches = 0;
  let deniedPoolClosed = 0;
  const deniedDaemon = await runNodeWorkerDaemon({
    signals: { on() {}, off() {} },
    pool: { async end() { deniedPoolClosed += 1; } },
    maxBatches: 5,
    pollIntervalMs: 100,
    async runBatch() {
      deniedBatches += 1;
      return {
        status: "DENIED",
        operation: "READY_TASK",
        tenantsVisited: 0,
        results: [],
        reason: "PRINCIPAL_NOT_AUTHORIZED",
      };
    },
  });
  assert.equal(deniedDaemon.status, "DENIED");
  assert.equal(deniedDaemon.batchesRun, 1, "denied authorization must stop the polling session");
  assert.equal(deniedBatches, 1);
  assert.equal(deniedPoolClosed, 1);

  console.log("Node worker process and bounded daemon supervisor: PASS");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
