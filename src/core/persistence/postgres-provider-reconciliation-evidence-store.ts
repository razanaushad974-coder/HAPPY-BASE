import { randomUUID } from "node:crypto";
import type {
  ProviderReconciliationEvidence,
  ProviderReconciliationEvidenceStore,
} from "../mission/provider-dispatch-reconciliation";
import type { TenantScope } from "../state/types";
import type { PostgresTenantSessionProvider, PgQueryable } from "./adapters/postgres-tenant-adapter";

type CompleteScope = TenantScope & { userId: string };
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const MAX_OBSERVATION_BYTES = 16 * 1024;
const MAX_IDENTIFIER_LENGTH = 512;

/**
 * Authenticated PostgreSQL implementation of the append-only reconciliation
 * evidence port. It persists a bounded allow-listed summary, never arbitrary
 * provider response/result bodies or credentials.
 *
 * The session provider must obtain identity from a trusted server principal
 * and establish a short-lived authenticated database transaction.
 */
export class PostgresProviderReconciliationEvidenceStore implements ProviderReconciliationEvidenceStore {
  constructor(
    private readonly sessions: PostgresTenantSessionProvider,
    private readonly scope: CompleteScope,
    private readonly createEvidenceId: () => string = randomUUID,
  ) {}

  async append(evidence: ProviderReconciliationEvidence): Promise<void> {
    const { organizationId, workspaceId, userId } = this.scope;
    if (!organizationId?.trim() || !workspaceId?.trim() || !userId?.trim()) {
      throw new Error("RECONCILIATION_TENANT_SCOPE_REQUIRED");
    }
    if (!UUID_PATTERN.test(organizationId) || !UUID_PATTERN.test(workspaceId) || !UUID_PATTERN.test(userId)) {
      throw new Error("RECONCILIATION_TENANT_SCOPE_INVALID");
    }
    if (
      !evidence.outboxId?.trim() || evidence.outboxId.length > MAX_IDENTIFIER_LENGTH ||
      !evidence.idempotencyKey?.trim() || evidence.idempotencyKey.length > MAX_IDENTIFIER_LENGTH ||
      !evidence.providerId?.trim() || evidence.providerId.length > MAX_IDENTIFIER_LENGTH
    ) {
      throw new Error("RECONCILIATION_EVIDENCE_BINDING_INVALID");
    }
    if (!UUID_PATTERN.test(evidence.outboxId)) {
      throw new Error("RECONCILIATION_OUTBOX_ID_INVALID");
    }
    const observedAtMs = Date.parse(evidence.observedAt);
    if (!Number.isFinite(observedAtMs)) {
      throw new Error("RECONCILIATION_OBSERVATION_TIMESTAMP_INVALID");
    }

    const observation = toSafeObservation(evidence);
    const serialized = JSON.stringify(observation);
    if (Buffer.byteLength(serialized, "utf8") > MAX_OBSERVATION_BYTES) {
      throw new Error("RECONCILIATION_OBSERVATION_TOO_LARGE");
    }
    const evidenceId = this.createEvidenceId();
    if (!UUID_PATTERN.test(evidenceId)) {
      throw new Error("RECONCILIATION_EVIDENCE_ID_INVALID");
    }

    await this.sessions.withSession(this.scope, async (client: PgQueryable) => {
      const result = await client.query<{ evidence_id: string }>(
        "select public.happy_append_dispatch_reconciliation_evidence($1::uuid,$2::uuid,$3::uuid,$4::uuid,$5::text,$6::text,$7::text,$8::timestamptz,$9::jsonb) as evidence_id",
        [
          organizationId, workspaceId, evidence.outboxId, evidenceId,
          evidence.idempotencyKey, evidence.providerId, evidence.observation.status,
          new Date(observedAtMs).toISOString(), serialized,
        ],
      );
      if (result.rows.length !== 1 || result.rows[0]?.evidence_id !== evidenceId) {
        throw new Error("RECONCILIATION_EVIDENCE_APPEND_UNCONFIRMED");
      }
    });
  }
}

function toSafeObservation(evidence: ProviderReconciliationEvidence): Record<string, string> {
  if (!evidence || typeof evidence !== "object" || !evidence.observation || typeof evidence.observation !== "object") {
    throw new Error("RECONCILIATION_OBSERVATION_INVALID");
  }
  const observation = evidence.observation;
  const allowedStatuses = new Set(["SUCCEEDED", "FAILED", "PROCESSING", "NOT_FOUND", "UNKNOWN"]);
  if (typeof observation.status !== "string" || !allowedStatuses.has(observation.status)) {
    throw new Error("RECONCILIATION_OBSERVATION_STATUS_INVALID");
  }
  const safe: Record<string, string> = { status: observation.status };
  if ("providerRequestId" in observation) {
    if (!observation.providerRequestId.trim() || observation.providerRequestId.length > MAX_IDENTIFIER_LENGTH) {
      throw new Error("RECONCILIATION_PROVIDER_REQUEST_ID_INVALID");
    }
    safe.providerRequestId = observation.providerRequestId;
  }
  if (observation.status === "FAILED") {
    if (typeof observation.code !== "string" || typeof observation.message !== "string") {
      throw new Error("RECONCILIATION_FAILURE_DETAILS_INVALID");
    }
    safe.code = observation.code.slice(0, 256);
    safe.message = observation.message.slice(0, 1024);
  }
  if (observation.status === "UNKNOWN") {
    if (typeof observation.reason !== "string") {
      throw new Error("RECONCILIATION_UNKNOWN_REASON_INVALID");
    }
    safe.reason = observation.reason.slice(0, 1024);
  }
  // Do not persist SUCCEEDED.result: provider bodies may contain credentials,
  // personal data, or unbounded payloads. Verification must use separately
  // scoped, capability-specific evidence.
  return safe;
}
