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
      readonly broker: WorkerDatabaseBroker;
      /** A real broker call must still prove the dedicated DB LOGIN session. */
      readonly liveDatabaseSession: "NOT_VERIFIED";
    };

export interface WorkerRuntimeCompositionDependencies {
  readonly identityProvider: TrustedWorkerIdentityResolver | null;
  readonly principalRegistry: WorkerPrincipalRegistry | null;
  readonly databaseBroker: WorkerDatabaseBroker | null;
}

/**
 * Resolves the three mandatory worker-runtime dependencies without silently
 * substituting a human session, service-role client, or in-memory scheduler.
 *
 * COMPOSITION_AVAILABLE means only that dependencies and the live principal
 * registry check are present. It does not claim that a database connection,
 * dedicated LOGIN role, RPC deployment, or hosted tenant authorization works.
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

  let resolution: WorkerIdentityResolution;
  try {
    resolution = await identityProvider.getVerifiedWorkerIdentity();
  } catch {
    return { status: "DENIED", reason: "IDENTITY_UNAVAILABLE" };
  }

  if (resolution.status !== "VERIFIED") {
    return resolution.status === "NOT_CONNECTED"
      ? { status: "NOT_CONNECTED", missing: "IDENTITY_PROVIDER" }
      : { status: "DENIED", reason: "IDENTITY_INVALID" };
  }
  if (!isVerifiedWorkerIdentity(resolution.identity)) {
    return { status: "DENIED", reason: "IDENTITY_INVALID" };
  }

  const authorization = await authorizeWorkerBrokerOperation({
    identity: resolution.identity,
    operation: input.operation,
    registry: principalRegistry,
    ...(input.now ? { now: input.now } : {}),
  });
  if (authorization.status !== "AUTHORIZED") {
    return { status: "DENIED", reason: "PRINCIPAL_NOT_AUTHORIZED" };
  }

  return Object.freeze({
    status: "COMPOSITION_AVAILABLE" as const,
    identity: resolution.identity,
    registration: authorization.registration,
    broker: databaseBroker,
    liveDatabaseSession: "NOT_VERIFIED" as const,
  });
}
