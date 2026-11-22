import {
  composeTrustedWorkerRuntime,
  type WorkerRuntimeCompositionDependencies,
} from "../../../core/mission/worker-runtime-composition";
import {
  TrustedWorkerIdentityProvider,
  type VerifiedWorkerCredentialClaims,
} from "../../../core/mission/trusted-worker-identity";
import type { WorkerDatabaseBroker, WorkerPrincipalRegistry } from "../../../core/mission/worker-database-broker";
import { MissionOrchestrator } from "../../../core/mission/orchestrator";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const now = 1_800_000_000;
const claims: VerifiedWorkerCredentialClaims = {
  issuer: "https://issuer.example.test",
  subject: "owner:project:environment:worker",
  audience: "happy-worker-broker",
  issuedAt: now - 10,
  notBefore: now - 10,
  expiresAt: now + 300,
  tokenId: "runtime-composition-token",
  environment: "staging",
  capabilities: ["CONTROL", "VERIFY"],
};
const identityProvider = new TrustedWorkerIdentityProvider(
  { getCredential: async () => "opaque-platform-credential" },
  { verifyCredential: async () => claims },
  {
    issuer: claims.issuer,
    audience: "happy-worker-broker",
    environment: "staging",
    allowedSubjects: [claims.subject],
    allowedCapabilities: ["CONTROL", "VERIFY"],
    maxCredentialLifetimeSeconds: 600,
  },
  () => now * 1000,
);
const registry: WorkerPrincipalRegistry = {
  findByIssuerSubjectEnvironment: async () => ({
    principalId: "principal-1",
    issuer: claims.issuer,
    subject: claims.subject,
    audience: "happy-worker-broker",
    environment: "staging",
    enabled: true,
    capabilities: ["CONTROL", "VERIFY"],
  }),
};
// This test double proves composition only; it is not a database connection.
const broker = {} as WorkerDatabaseBroker;
const complete: WorkerRuntimeCompositionDependencies = {
  identityProvider,
  principalRegistry: registry,
  databaseBroker: broker,
};

async function run() {
  const defaultOrchestrator = new MissionOrchestrator();
  const defaultWorkerStatus = await defaultOrchestrator.prepareWorkerRuntimeOperation("claim_task");
  assert(defaultWorkerStatus.status === "NOT_CONNECTED",
    "default mission orchestrator must not claim a worker runtime is connected");

  const configuredOrchestrator = new MissionOrchestrator(complete);
  const orchestratorWorkerStatus = await configuredOrchestrator.prepareWorkerRuntimeOperation(
    "claim_task",
    () => now * 1000,
  );
  assert(orchestratorWorkerStatus.status === "COMPOSITION_AVAILABLE",
    "configured orchestrator must expose the explicit worker authorization seam");

  const missingIdentity = await composeTrustedWorkerRuntime({
    dependencies: { ...complete, identityProvider: null },
    operation: "claim_task",
    now: () => now * 1000,
  });
  assert(missingIdentity.status === "NOT_CONNECTED" && missingIdentity.missing === "IDENTITY_PROVIDER",
    "missing credential source must remain explicitly disconnected");

  const missingRegistry = await composeTrustedWorkerRuntime({
    dependencies: { ...complete, principalRegistry: null },
    operation: "claim_task",
  });
  assert(missingRegistry.status === "NOT_CONNECTED" && missingRegistry.missing === "PRINCIPAL_REGISTRY",
    "missing principal registry must remain disconnected");

  const missingBroker = await composeTrustedWorkerRuntime({
    dependencies: { ...complete, databaseBroker: null },
    operation: "claim_task",
  });
  assert(missingBroker.status === "NOT_CONNECTED" && missingBroker.missing === "DATABASE_BROKER",
    "missing database broker must remain disconnected");

  const composed = await composeTrustedWorkerRuntime({
    dependencies: complete,
    operation: "claim_task",
    now: () => now * 1000,
  });
  assert(composed.status === "COMPOSITION_AVAILABLE", "valid worker dependencies should compose");
  assert(composed.status === "COMPOSITION_AVAILABLE" && composed.liveDatabaseSession === "NOT_VERIFIED",
    "composition must not claim a live PostgreSQL session");
  assert(composed.status === "COMPOSITION_AVAILABLE" && composed.broker === broker,
    "composition must preserve the injected fixed-operation broker");

  const revoked = await composeTrustedWorkerRuntime({
    dependencies: {
      ...complete,
      principalRegistry: {
        findByIssuerSubjectEnvironment: async () => ({
          principalId: "principal-1",
          issuer: claims.issuer,
          subject: claims.subject,
          audience: "happy-worker-broker",
          environment: "staging",
          enabled: false,
          capabilities: ["CONTROL", "VERIFY"],
        }),
      },
    },
    operation: "claim_task",
    now: () => now * 1000,
  });
  assert(revoked.status === "DENIED" && revoked.reason === "PRINCIPAL_NOT_AUTHORIZED",
    "disabled or revoked principal must be denied before broker use");

  const verifyAllowed = await composeTrustedWorkerRuntime({
    dependencies: complete,
    operation: "append_reconciliation_evidence",
    now: () => now * 1000,
  });
  assert(verifyAllowed.status === "COMPOSITION_AVAILABLE",
    "VERIFY capability should allow reconciliation evidence composition");

  const capabilityDenied = await composeTrustedWorkerRuntime({
    dependencies: {
      ...complete,
      principalRegistry: {
        findByIssuerSubjectEnvironment: async () => ({
          principalId: "principal-1",
          issuer: claims.issuer,
          subject: claims.subject,
          audience: "happy-worker-broker",
          environment: "staging",
          enabled: true,
          capabilities: ["CONTROL"],
        }),
      },
    },
    operation: "append_reconciliation_evidence",
    now: () => now * 1000,
  });
  assert(capabilityDenied.status === "DENIED",
    "registry missing VERIFY capability must deny evidence operations");

  const registryUnavailable = await composeTrustedWorkerRuntime({
    dependencies: {
      ...complete,
      principalRegistry: {
        findByIssuerSubjectEnvironment: async () => { throw new Error("registry unavailable"); },
      },
    },
    operation: "claim_task",
    now: () => now * 1000,
  });
  assert(registryUnavailable.status === "DENIED",
    "registry outage must fail closed");

  const forgedIdentity = await composeTrustedWorkerRuntime({
    dependencies: {
      ...complete,
      identityProvider: {
        getVerifiedWorkerIdentity: async () => ({
          status: "VERIFIED" as const,
          identity: { ...({} as object), principal: claims.subject } as never,
        }),
      },
    },
    operation: "claim_task",
    now: () => now * 1000,
  });
  assert(forgedIdentity.status === "DENIED" && forgedIdentity.reason === "IDENTITY_INVALID",
    "plain copied identity claims must not pass runtime attestation");

  const expired = await composeTrustedWorkerRuntime({
    dependencies: complete,
    operation: "claim_task",
    now: () => (now + 301) * 1000,
  });
  assert(expired.status === "DENIED", "expired workload identity must be denied");

  console.log("Worker runtime composition tests: PASS");
}

void run();
