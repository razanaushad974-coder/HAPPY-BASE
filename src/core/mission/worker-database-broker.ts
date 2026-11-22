import {
  isVerifiedWorkerIdentity,
  type VerifiedWorkerIdentity,
  type WorkerCapability,
} from "./trusted-worker-identity";

/**
 * Code-level boundary for a future worker identity broker.
 *
 * This module intentionally contains no PostgreSQL client, Supabase service
 * key, SQL execution surface, HTTP adapter, or credential provisioning. A
 * production connector must authenticate as a distinct database principal;
 * passing these fields as SQL parameters or custom GUCs is NOT authentication.
 */

export interface WorkerPrincipalRegistration {
  readonly principalId: string;
  readonly issuer: string;
  readonly subject: string;
  readonly audience: string;
  readonly environment: string;
  readonly enabled: boolean;
  readonly capabilities: readonly WorkerCapability[];
  readonly revokedAt?: number | null;
}

export interface WorkerPrincipalRegistry {
  /** Must read from an operator-controlled, authoritative registry. */
  findByIssuerSubjectEnvironment(input: {
    issuer: string;
    subject: string;
    environment: string;
  }): Promise<WorkerPrincipalRegistration | null>;
}

export type WorkerBrokerOperation =
  | "claim_task"
  | "enqueue_dispatch"
  | "record_dispatch_outcome"
  | "append_reconciliation_evidence"
  | "list_reconciliation_evidence";

const OPERATION_CAPABILITY: Readonly<Record<WorkerBrokerOperation, WorkerCapability>> = {
  claim_task: "CONTROL",
  enqueue_dispatch: "CONTROL",
  record_dispatch_outcome: "CONTROL",
  append_reconciliation_evidence: "VERIFY",
  list_reconciliation_evidence: "VERIFY",
};

export type WorkerBrokerAuthorization =
  | { readonly status: "AUTHORIZED"; readonly registration: WorkerPrincipalRegistration }
  | { readonly status: "NOT_CONNECTED" | "DENIED" };

/**
 * Resolves an attested worker against the live registry on every broker
 * authorization. No positive registry cache is provided here: revocation must
 * take effect at the authoritative lookup boundary.
 */
export async function authorizeWorkerBrokerOperation(input: {
  identity: VerifiedWorkerIdentity | null;
  operation: WorkerBrokerOperation;
  registry: WorkerPrincipalRegistry | null;
  now?: () => number;
}): Promise<WorkerBrokerAuthorization> {
  if (!input.registry) return { status: "NOT_CONNECTED" };
  if (!isVerifiedWorkerIdentity(input.identity)) return { status: "DENIED" };

  try {
    const nowMs = (input.now ?? Date.now)();
    if (!Number.isFinite(nowMs) || nowMs < 0) return { status: "DENIED" };
    const now = Math.floor(nowMs / 1000);
    if (input.identity.expiresAt <= now) return { status: "DENIED" };

    const registration = await input.registry.findByIssuerSubjectEnvironment({
      issuer: input.identity.issuer,
      subject: input.identity.principal,
      environment: input.identity.environment,
    });
    if (!registration) return { status: "DENIED" };

    const requiredCapability = OPERATION_CAPABILITY[input.operation];
    const capabilities = registration.capabilities;
    if (
      typeof registration.principalId !== "string" || !registration.principalId.trim() ||
      typeof registration.issuer !== "string" ||
      typeof registration.subject !== "string" ||
      typeof registration.environment !== "string" ||
      typeof registration.audience !== "string" ||
      typeof registration.enabled !== "boolean" ||
      !Array.isArray(capabilities) ||
      capabilities.length === 0 ||
      capabilities.some((capability) =>
        typeof capability !== "string" ||
        !Object.values(OPERATION_CAPABILITY).includes(capability as WorkerCapability) &&
        !["API", "BROWSER", "FILE", "DATABASE", "DEPLOY", "PUBLISH"].includes(capability)
      ) ||
      new Set(capabilities).size !== capabilities.length ||
      !registration.enabled ||
      registration.revokedAt != null ||
      registration.issuer !== input.identity.issuer ||
      registration.subject !== input.identity.principal ||
      registration.environment !== input.identity.environment ||
      registration.audience !== input.identity.audience ||
      !capabilities.includes(requiredCapability) ||
      !input.identity.capabilities.includes(requiredCapability)
    ) return { status: "DENIED" };

    // Return an immutable snapshot, not a mutable object owned by the registry.
    const authorizedRegistration: WorkerPrincipalRegistration = Object.freeze({
      principalId: registration.principalId,
      issuer: registration.issuer,
      subject: registration.subject,
      audience: registration.audience,
      environment: registration.environment,
      enabled: registration.enabled,
      capabilities: Object.freeze([...capabilities]),
      revokedAt: registration.revokedAt ?? null,
    });
    return { status: "AUTHORIZED", registration: authorizedRegistration };
  } catch {
    // Registry outage or malformed records must never downgrade to user auth.
    return { status: "DENIED" };
  }
}

/**
 * Narrow operation interface for a future authenticated DB connector.
 * Implementations must obtain their authority from a distinct PostgreSQL
 * login/session principal and must not accept caller-provided principal IDs.
 * No generic query, arbitrary SQL, or table CRUD method is exposed.
 */
export interface WorkerDatabaseBroker {
  claimTask(input: {
    tenantScope: { organizationId: string; workspaceId: string };
    missionId: string;
    taskId: string;
    idempotencyKey: string;
  }): Promise<unknown>;

  enqueueDispatch(input: {
    tenantScope: { organizationId: string; workspaceId: string };
    executionRequestId: string;
    leaseId: string;
    fencingToken: number;
    payloadDigest: string;
  }): Promise<unknown>;

  recordDispatchOutcome(input: {
    tenantScope: { organizationId: string; workspaceId: string };
    outboxId: string;
    leaseId: string;
    fencingToken: number;
    outcomeId: string;
    status: "ACKNOWLEDGED" | "AMBIGUOUS" | "FAILED" | "RECONCILIATION_REQUIRED";
    outcome: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;

  appendReconciliationEvidence(input: {
    tenantScope: { organizationId: string; workspaceId: string };
    outboxId: string;
    evidenceId: string;
    idempotencyKey: string;
    providerId: string;
    observedAt: string;
    status: "SUCCEEDED" | "FAILED" | "PROCESSING" | "NOT_FOUND" | "UNKNOWN";
    observation: Readonly<Record<string, unknown>>;
  }): Promise<unknown>;

  listReconciliationEvidence(input: {
    tenantScope: { organizationId: string; workspaceId: string };
    outboxId: string;
    missionId: string;
    taskId: string;
    executionRequestId: string;
  }): Promise<readonly unknown[]>;
}
