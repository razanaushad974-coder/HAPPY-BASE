import {
  authorizeWorkerBrokerOperation,
  type WorkerBrokerOperation,
  type WorkerDatabaseBroker,
  type WorkerPrincipalRegistration,
  type WorkerPrincipalRegistry,
} from "./worker-database-broker";
import {
  isVerifiedWorkerIdentity,
  type VerifiedWorkerIdentity,
  type WorkerIdentityResolution,
} from "./trusted-worker-identity";
import type { TrustedWorkerIdentityResolver } from "./durable-dispatch-worker-contract";

export type WorkerRuntimeComposition =
  | {
      readonly status: "NOT_CONNECTED";
      readonly missing: "IDENTITY_PROVIDER" | "PRINCIPAL_REGISTRY" | "DATABASE_BROKER";
    }
  | {
      readonly status: "DENIED";
      readonly reason: "IDENTITY_UNAVAILABLE" | "IDENTITY_INVALID" | "PRINCIPAL_NOT_AUTHORIZED";
    }
  | {
      readonly status: "COMPOSITION_AVAILABLE";
      readonly identity: VerifiedWorkerIdentity;
      readonly registration: WorkerPrincipalRegistration;
      /** Every method re-resolves identity and registry authorization before touching the raw broker. */
      readonly broker: WorkerDatabaseBroker;
      /** A real broker call must still prove the dedicated DB LOGIN session. */
      readonly liveDatabaseSession: "NOT_VERIFIED";
    };

export interface WorkerRuntimeCompositionDependencies {
  readonly identityProvider: TrustedWorkerIdentityResolver | null;
  readonly principalRegistry: WorkerPrincipalRegistry | null;
  readonly databaseBroker: WorkerDatabaseBroker | null;
}

export class WorkerBrokerAuthorizationError extends Error {
  constructor(readonly reason: "IDENTITY_UNAVAILABLE" | "IDENTITY_INVALID" | "PRINCIPAL_NOT_AUTHORIZED") {
    super(reason);
    this.name = "WorkerBrokerAuthorizationError";
  }
}

interface WorkerAuthorizationSnapshot {
  readonly identity: VerifiedWorkerIdentity;
  readonly registration: WorkerPrincipalRegistration;
}

type WorkerAuthorizationCheck = (
  operation: WorkerBrokerOperation,
) => Promise<WorkerAuthorizationSnapshot>;

/**
 * The returned facade never exposes the raw broker. Identity and operator
 * registry authorization are refreshed immediately before every operation,
 * so a previously composed runtime cannot retain access after revocation or
 * capability downgrade.
 */
function createAuthorizedBroker(
  rawBroker: WorkerDatabaseBroker,
  authorize: WorkerAuthorizationCheck,
): WorkerDatabaseBroker {
  return Object.freeze({
    claimTask: async (input: Parameters<WorkerDatabaseBroker["claimTask"]>[0]) => {
      await authorize("claim_task");
      return rawBroker.claimTask(input);
    },
    heartbeatLease: async (input: Parameters<WorkerDatabaseBroker["heartbeatLease"]>[0]) => {
      await authorize("claim_task");
      return rawBroker.heartbeatLease(input);
    },
    enqueueDispatch: async (input: Parameters<WorkerDatabaseBroker["enqueueDispatch"]>[0]) => {
      await authorize("enqueue_dispatch");
      return rawBroker.enqueueDispatch(input);
    },
    claimDispatch: async (input: Parameters<WorkerDatabaseBroker["claimDispatch"]>[0]) => {
      await authorize("claim_task");
      return rawBroker.claimDispatch(input);
    },
    recordDispatchOutcome: async (input: Parameters<WorkerDatabaseBroker["recordDispatchOutcome"]>[0]) => {
      await authorize("record_dispatch_outcome");
      return rawBroker.recordDispatchOutcome(input);
    },
    appendReconciliationEvidence: async (input: Parameters<WorkerDatabaseBroker["appendReconciliationEvidence"]>[0]) => {
      await authorize("append_reconciliation_evidence");
      return rawBroker.appendReconciliationEvidence(input);
    },
    listReconciliationEvidence: async (input: Parameters<WorkerDatabaseBroker["listReconciliationEvidence"]>[0]) => {
      await authorize("list_reconciliation_evidence");
      return rawBroker.listReconciliationEvidence(input);
    },
  });
}

/**
 * Resolves mandatory worker dependencies without substituting a human
 * session, service-role client, or in-memory scheduler.
 *
 * COMPOSITION_AVAILABLE means only that initial composition succeeded. It
 * does not claim a database connection, dedicated LOGIN role, RPC deployment,
 * or hosted tenant authorization works.
 */
export async function composeTrustedWorkerRuntime(input: {
  readonly dependencies: WorkerRuntimeCompositionDependencies;
  readonly operation: WorkerBrokerOperation;
  readonly now?: () => number;
}): Promise<WorkerRuntimeComposition> {
  const { identityProvider, principalRegistry, databaseBroker } = input.dependencies;

  if (!identityProvider) return { status: "NOT_CONNECTED", missing: "IDENTITY_PROVIDER" };
  if (!principalRegistry) return { status: "NOT_CONNECTED", missing: "PRINCIPAL_REGISTRY" };
  if (!databaseBroker) return { status: "NOT_CONNECTED", missing: "DATABASE_BROKER" };

  const authorize: WorkerAuthorizationCheck = async (operation) => {
    let resolution: WorkerIdentityResolution;
    try {
      resolution = await identityProvider.getVerifiedWorkerIdentity();
    } catch {
      throw new WorkerBrokerAuthorizationError("IDENTITY_UNAVAILABLE");
    }
    if (resolution.status === "NOT_CONNECTED") {
      throw new WorkerBrokerAuthorizationError("IDENTITY_UNAVAILABLE");
    }
    if (resolution.status !== "VERIFIED" || !isVerifiedWorkerIdentity(resolution.identity)) {
      throw new WorkerBrokerAuthorizationError("IDENTITY_INVALID");
    }

    const authorization = await authorizeWorkerBrokerOperation({
      identity: resolution.identity,
      operation,
      registry: principalRegistry,
      ...(input.now ? { now: input.now } : {}),
    });
    if (authorization.status !== "AUTHORIZED") {
      throw new WorkerBrokerAuthorizationError("PRINCIPAL_NOT_AUTHORIZED");
    }
    return Object.freeze({
      identity: resolution.identity,
      registration: authorization.registration,
    });
  };

  let initialAuthorization: WorkerAuthorizationSnapshot;
  try {
    // Capture identity and registration from the same authorization pass.
    // This avoids a second provider lookup producing a mismatched descriptive
    // snapshot if credentials rotate between calls.
    initialAuthorization = await authorize(input.operation);
  } catch (error) {
    return {
      status: "DENIED",
      reason: error instanceof WorkerBrokerAuthorizationError
        ? error.reason
        : "PRINCIPAL_NOT_AUTHORIZED",
    };
  }

  return Object.freeze({
    status: "COMPOSITION_AVAILABLE" as const,
    identity: initialAuthorization.identity,
    registration: initialAuthorization.registration,
    broker: createAuthorizedBroker(databaseBroker, authorize),
    liveDatabaseSession: "NOT_VERIFIED" as const,
  });
}
