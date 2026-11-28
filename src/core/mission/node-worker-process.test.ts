import assert from "node:assert/strict";
import { runNodeWorkerProcess, type NodeWorkerShutdownSignal } from "./node-worker-process";

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

  console.log("Node worker process supervisor: PASS");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
