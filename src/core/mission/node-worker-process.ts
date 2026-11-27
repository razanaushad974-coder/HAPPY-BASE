import type { NodeWorkerBatchResult } from "./node-worker-scheduler";

export type NodeWorkerShutdownSignal = "SIGINT" | "SIGTERM";

export interface NodeWorkerSignalEmitter {
  on(signal: NodeWorkerShutdownSignal, listener: () => void): unknown;
  off(signal: NodeWorkerShutdownSignal, listener: () => void): unknown;
}

export interface NodeWorkerPoolLifecycle {
  end(): Promise<void>;
}

export interface NodeWorkerProcessResult {
  readonly batch: NodeWorkerBatchResult;
  readonly shutdownSignal: NodeWorkerShutdownSignal | null;
}

/**
 * Runs exactly one bounded worker batch under Node process signal supervision.
 *
 * SIGINT/SIGTERM aborts the batch between tenant operations. The supervisor
 * waits for the current bounded operation to settle before closing the pool,
 * then removes both process listeners. It never calls process.exit(), retries
 * ambiguous provider effects, or closes the pool while a broker transaction is
 * still running. The host owns its hard process deadline and restart policy.
 */
export async function runNodeWorkerProcess(input: {
  readonly signals: NodeWorkerSignalEmitter;
  readonly pool: NodeWorkerPoolLifecycle;
  readonly runBatch: (signal: AbortSignal) => Promise<NodeWorkerBatchResult>;
}): Promise<NodeWorkerProcessResult> {
  if (
    !input || !input.signals ||
    typeof input.signals.on !== "function" ||
    typeof input.signals.off !== "function" ||
    !input.pool || typeof input.pool.end !== "function" ||
    typeof input.runBatch !== "function"
  ) {
    throw new TypeError("Node worker process requires signal, pool lifecycle, and batch adapters.");
  }

  const controller = new AbortController();
  let shutdownSignal: NodeWorkerShutdownSignal | null = null;
  const requestShutdown = (signal: NodeWorkerShutdownSignal) => {
    if (shutdownSignal !== null) return;
    shutdownSignal = signal;
    controller.abort();
  };
  const onInterrupt = () => requestShutdown("SIGINT");
  const onTerminate = () => requestShutdown("SIGTERM");

  input.signals.on("SIGINT", onInterrupt);
  input.signals.on("SIGTERM", onTerminate);

  let batchError: unknown;
  try {
    const batch = await input.runBatch(controller.signal);
    return Object.freeze({ batch, shutdownSignal });
  } catch (error) {
    batchError = error;
    throw error;
  } finally {
    input.signals.off("SIGINT", onInterrupt);
    input.signals.off("SIGTERM", onTerminate);
    try {
      await input.pool.end();
    } catch (closeError) {
      if (batchError === undefined) throw closeError;
    }
  }
}
