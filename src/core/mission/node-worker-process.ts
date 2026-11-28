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
 * then removes any listeners it successfully registered. It never calls
 * process.exit(), retries ambiguous provider effects, or closes the pool while
 * a broker transaction is still running. The host owns its hard process
 * deadline and restart policy.
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
  let interruptRegistered = false;
  let terminateRegistered = false;
  let primaryError: unknown;

  try {
    input.signals.on("SIGINT", onInterrupt);
    interruptRegistered = true;
    input.signals.on("SIGTERM", onTerminate);
    terminateRegistered = true;
    const batch = await input.runBatch(controller.signal);
    return Object.freeze({ batch, shutdownSignal });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    if (terminateRegistered) {
      try { input.signals.off("SIGTERM", onTerminate); }
      catch (error) { cleanupError ??= error; }
    }
    if (interruptRegistered) {
      try { input.signals.off("SIGINT", onInterrupt); }
      catch (error) { cleanupError ??= error; }
    }
    try {
      await input.pool.end();
    } catch (error) {
      cleanupError ??= error;
    }
    if (primaryError === undefined && cleanupError !== undefined) {
      throw cleanupError;
    }
  }
}


export interface NodeWorkerDaemonResult {
  readonly status: "COMPLETED" | "STOPPED" | "DENIED" | "NOT_CONNECTED";
  readonly batchesRun: number;
  readonly tenantsVisited: number;
  readonly batches: readonly NodeWorkerBatchResult[];
  readonly shutdownSignal: NodeWorkerShutdownSignal | null;
  readonly reason?: string;
}

function waitForNextWorkerPoll(signal: AbortSignal, pollIntervalMs: number): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      resolve();
    };
    const timer = setTimeout(finish, pollIntervalMs);
    signal.addEventListener("abort", finish, { once: true });
  });
}

/**
 * Runs a bounded polling session over the same host-owned pool.
 *
 * Unlike runNodeWorkerProcess(), which performs exactly one batch, this
 * supervisor executes sequential batches with a bounded poll interval and a
 * mandatory maximum batch count. It never overlaps batches, never retries a
 * DENIED/NOT_CONNECTED/STOPPED outcome, and closes the pool only after the
 * current batch or poll wait has settled. A host process manager may restart
 * another bounded session after this function returns.
 */
export async function runNodeWorkerDaemon(input: {
  readonly signals: NodeWorkerSignalEmitter;
  readonly pool: NodeWorkerPoolLifecycle;
  readonly runBatch: (signal: AbortSignal) => Promise<NodeWorkerBatchResult>;
  readonly maxBatches: number;
  readonly pollIntervalMs: number;
}): Promise<NodeWorkerDaemonResult> {
  if (
    !input || !input.signals ||
    typeof input.signals.on !== "function" ||
    typeof input.signals.off !== "function" ||
    !input.pool || typeof input.pool.end !== "function" ||
    typeof input.runBatch !== "function"
  ) {
    throw new TypeError("Node worker daemon requires signal, pool lifecycle, and batch adapters.");
  }
  if (!Number.isSafeInteger(input.maxBatches) || input.maxBatches < 1 || input.maxBatches > 100) {
    throw new RangeError("Node worker daemon maxBatches must be between 1 and 100.");
  }
  if (!Number.isSafeInteger(input.pollIntervalMs) || input.pollIntervalMs < 100 || input.pollIntervalMs > 60_000) {
    throw new RangeError("Node worker daemon pollIntervalMs must be between 100 and 60,000 milliseconds.");
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
  let interruptRegistered = false;
  let terminateRegistered = false;
  let primaryError: unknown;

  try {
    input.signals.on("SIGINT", onInterrupt);
    interruptRegistered = true;
    input.signals.on("SIGTERM", onTerminate);
    terminateRegistered = true;

    const batches: NodeWorkerBatchResult[] = [];
    let tenantsVisited = 0;
    let status: NodeWorkerDaemonResult["status"] = "COMPLETED";
    let reason: string | undefined;

    for (let index = 0; index < input.maxBatches; index += 1) {
      if (controller.signal.aborted) {
        status = "STOPPED";
        break;
      }

      const batch = await input.runBatch(controller.signal);
      batches.push(batch);
      tenantsVisited += batch.tenantsVisited;

      if (batch.status !== "COMPLETED") {
        status = batch.status;
        reason = batch.reason;
        break;
      }
      if (controller.signal.aborted) {
        status = "STOPPED";
        break;
      }
      if (index + 1 < input.maxBatches) {
        await waitForNextWorkerPoll(controller.signal, input.pollIntervalMs);
        if (controller.signal.aborted) {
          status = "STOPPED";
          break;
        }
      }
    }

    if (shutdownSignal !== null) status = "STOPPED";
    if (status === "COMPLETED" && batches.length === input.maxBatches) {
      reason = "MAX_BATCHES_REACHED";
    }

    return Object.freeze({
      status,
      batchesRun: batches.length,
      tenantsVisited,
      batches: Object.freeze([...batches]),
      shutdownSignal,
      ...(reason ? { reason } : {}),
    });
  } catch (error) {
    primaryError = error;
    throw error;
  } finally {
    let cleanupError: unknown;
    if (terminateRegistered) {
      try { input.signals.off("SIGTERM", onTerminate); }
      catch (error) { cleanupError ??= error; }
    }
    if (interruptRegistered) {
      try { input.signals.off("SIGINT", onInterrupt); }
      catch (error) { cleanupError ??= error; }
    }
    try {
      await input.pool.end();
    } catch (error) {
      cleanupError ??= error;
    }
    if (primaryError === undefined && cleanupError !== undefined) {
      throw cleanupError;
    }
  }
}
