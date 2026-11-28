import {
  composeTrustedWorkerRuntime,
  WorkerBrokerAuthorizationError,
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
let liveRegistration = {
  principalId: "principal-1",
  issuer: claims.issuer,
  subject: claims.subject,
  audience: "happy-worker-broker",
  environment: "staging",
  enabled: true,
  capabilities: ["CONTROL", "VERIFY"] as const,
};
const registry: WorkerPrincipalRegistry = {
  findByIssuerSubjectEnvironment: async () => liveRegistration,
};
// This test double proves guarded dispatch only; it is not a database connection.
let brokerCalls = 0;
const broker = {
  claimTask: async () => {
    brokerCalls += 1;
    return {
      leaseId: "lease-1", attempt: 1, fencingToken: 1,
      expiresAt: new Date(now * 1000 + 60_000).toISOString(), taskVersion: 1,
      executionRequest: {
        id: "request-1", missionId: "mission-1", taskId: "task-1",
        capability: "API", action: "POST", input: {},
        requiresApproval: true, approved: true, risk: "HIGH",
        createdAt: new Date(now * 1000).toISOString(),
      },
    };
  },
  heartbeatLease: async () => { brokerCalls += 1; return "2026-11-22T20:00:00.000Z"; },
  enqueueDispatch: async () => { brokerCalls += 1; return {}; },
  claimNextDispatch: async () => { brokerCalls += 1; return null; },
  claimDispatch: async () => { brokerCalls += 1; return {}; },
  recordDispatchOutcome: async () => { brokerCalls += 1; return {}; },
  appendReconciliationEvidence: async () => { brokerCalls += 1; return "evidence-1"; },
  listReconciliationEvidence: async () => { brokerCalls += 1; return []; },
} as unknown as WorkerDatabaseBroker;
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

  const disconnectedRecovery = await defaultOrchestrator.assessWorkerMissionRecovery({
    scope: { organizationId: "org-1", workspaceId: "ws-1", userId: "user-1" },
    tenantScope: {
      workerPrincipalId: "principal-1",
      organizationId: "org-1",
      workspaceId: "ws-1",
      userId: "user-1",
    },
    persistence: {} as never,
    missionId: "mission-1",
  });
  assert("status" in disconnectedRecovery && disconnectedRecovery.status === "NOT_CONNECTED",
    "worker recovery assessment must remain disconnected without trusted worker dependencies");

  let mismatchedRecoveryScopeDenied = false;
  try {
    await defaultOrchestrator.assessWorkerMissionRecovery({
      scope: { organizationId: "org-1", workspaceId: "ws-1", userId: "user-1" },
      tenantScope: {
        workerPrincipalId: "principal-1",
        organizationId: "other-org",
        workspaceId: "ws-1",
        userId: "user-1",
      },
      persistence: {} as never,
      missionId: "mission-1",
    });
  } catch (error) {
    mismatchedRecoveryScopeDenied =
      error instanceof Error && error.name === "TenantPersistenceError" &&
      error.message.includes("same tenant scope");
  }
  assert(mismatchedRecoveryScopeDenied,
    "worker recovery must reject mismatched scheduler and worker tenant scopes before composition");

  const configuredOrchestrator = new MissionOrchestrator(complete);
  const orchestratorWorkerStatus = await configuredOrchestrator.prepareWorkerRuntimeOperation(
    "claim_task",
    () => now * 1000,
  );
  assert(orchestratorWorkerStatus.status === "COMPOSITION_AVAILABLE",
    "configured orchestrator must expose the explicit worker authorization seam");

  const recoveryMission = {
    id: "mission-recovery", goal: "recover", planId: "plan-recovery",
    status: "RUNNING", taskIds: ["task-recovery"], rootTaskIds: ["task-recovery"],
    completedTaskIds: [], failedTaskIds: [], blockedTaskIds: [], progressPercent: 0,
    createdAt: new Date(now * 1000).toISOString(),
    updatedAt: new Date(now * 1000).toISOString(),
  };
  const recoveryTask = {
    id: "task-recovery", missionId: "mission-recovery", action: "BUILD",
    title: "Recovery task", description: "Test recovery evidence",
    status: "RUNNING", dependencyIds: [], dependentTaskIds: [], order: 1,
    retryCount: 0, maxRetries: 3, requiresApproval: false,
    verificationRequired: true, createdAt: recoveryMission.createdAt,
    updatedAt: recoveryMission.updatedAt,
  };
  const recoveryPersistence = {
    async get(_scope: unknown, entityType: string) {
      const data = entityType === "MISSION" ? recoveryMission :
        entityType === "TASK" ? recoveryTask : undefined;
      if (!data) return undefined;
      return {
        id: data.id, entityType, version: 1,
        createdAt: recoveryMission.createdAt, updatedAt: recoveryMission.updatedAt,
        organizationId: "org-1", workspaceId: "ws-1", userId: "user-1", data,
      };
    },
    async list() {
      return [{
        id: "execution-recovery", entityType: "EXECUTION", version: 1,
        createdAt: recoveryMission.createdAt, updatedAt: recoveryMission.updatedAt,
        organizationId: "org-1", workspaceId: "ws-1", userId: "user-1",
        data: {
          id: "result-recovery", missionId: "mission-recovery",
          taskId: "task-recovery", requestId: "execution-recovery",
          outboxId: "outbox-recovery", status: "RUNNING",
        },
      }];
    },
  } as never;
  const workerRecovery = await configuredOrchestrator.assessWorkerMissionRecovery({
    scope: { organizationId: "org-1", workspaceId: "ws-1", userId: "user-1" },
    tenantScope: {
      workerPrincipalId: "principal-1", organizationId: "org-1",
      workspaceId: "ws-1", userId: "user-1",
    },
    persistence: recoveryPersistence,
    missionId: "mission-recovery",
    now: () => now * 1000,
  });
  assert("assessments" in workerRecovery &&
    workerRecovery.assessments[0]?.disposition === "EXECUTION_OUTCOME_UNKNOWN",
    "configured orchestrator must return the read-only recovery assessment");
  assert(brokerCalls === 1,
    "orchestrator recovery must retrieve evidence through the guarded worker broker");

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

  let compositionIdentityResolutions = 0;
  const countedIdentityProvider = {
    getVerifiedWorkerIdentity: async () => {
      compositionIdentityResolutions += 1;
      return identityProvider.getVerifiedWorkerIdentity();
    },
  };
  const countedComposition = await composeTrustedWorkerRuntime({
    dependencies: { ...complete, identityProvider: countedIdentityProvider },
    operation: "claim_task",
    now: () => now * 1000,
  });
  assert(countedComposition.status === "COMPOSITION_AVAILABLE",
    "counted identity provider should compose successfully");
  assert(compositionIdentityResolutions === 1,
    "composition identity and registry snapshot must come from one authorization resolution");

  const composed = await composeTrustedWorkerRuntime({
    dependencies: complete,
    operation: "claim_task",
    now: () => now * 1000,
  });
  assert(composed.status === "COMPOSITION_AVAILABLE", "valid worker dependencies should compose");
  assert(composed.status === "COMPOSITION_AVAILABLE" && composed.liveDatabaseSession === "NOT_VERIFIED",
    "composition must not claim a live PostgreSQL session");
  assert(composed.status === "COMPOSITION_AVAILABLE" && composed.broker !== broker,
    "composition must expose a guarded facade, never the raw broker");
  if (composed.status === "COMPOSITION_AVAILABLE") {
    await composed.broker.claimTask({
      tenantScope: { workerPrincipalId: "principal-1", organizationId: "org-1", workspaceId: "ws-1", userId: "user-1" },
      missionId: "mission-1", taskId: "task-1", ownerId: claims.subject, leaseMilliseconds: 30_000,
    });
  }
  assert(Number(brokerCalls) === 2, "authorized broker call should reach the underlying broker after the recovery evidence read");
  liveRegistration = { ...liveRegistration, enabled: false };
  let revokedCallDenied = false;
  try {
    if (composed.status === "COMPOSITION_AVAILABLE") {
      await composed.broker.claimTask({
        tenantScope: { workerPrincipalId: "principal-1", organizationId: "org-1", workspaceId: "ws-1", userId: "user-1" },
        missionId: "mission-1", taskId: "task-2", ownerId: claims.subject, leaseMilliseconds: 30_000,
      });
    }
  } catch (error) {
    revokedCallDenied = error instanceof WorkerBrokerAuthorizationError &&
      error.reason === "PRINCIPAL_NOT_AUTHORIZED";
  }
  assert(revokedCallDenied, "revocation after composition must deny subsequent broker calls");
  assert(Number(brokerCalls) === 2, "revoked call must not reach the raw broker after the earlier recovery and authorized claim calls");

  if (composed.status === "COMPOSITION_AVAILABLE") {
    const scope = {
      workerPrincipalId: "principal-1",
      organizationId: "org-1",
      workspaceId: "ws-1",
      userId: "user-1",
    };
    const revokedOperations: Array<() => Promise<unknown>> = [
      () => composed.broker.heartbeatLease({
        tenantScope: scope, missionId: "mission-1", taskId: "task-1",
        leaseId: "lease-1", ownerId: claims.subject, fencingToken: 1,
        leaseMilliseconds: 30_000,
      }),
      () => composed.broker.enqueueDispatch({
        tenantScope: scope, missionId: "mission-1", taskId: "task-1",
        leaseId: "lease-1", ownerId: claims.subject, fencingToken: 1,
        executionRequestId: "request-1", idempotencyKey: "idem-1",
        capability: "API", action: "GET", payloadDigest: "sha256:test", payload: {},
      }),
      () => composed.broker.claimNextDispatch({
        tenantScope: scope, ownerId: "worker-instance-1",
      }),
      () => composed.broker.claimDispatch({
        tenantScope: scope, outboxId: "outbox-1", leaseId: "lease-1",
        ownerId: claims.subject, fencingToken: 1,
      }),
      () => composed.broker.recordDispatchOutcome({
        tenantScope: scope, outboxId: "outbox-1", leaseId: "lease-1",
        ownerId: claims.subject, fencingToken: 1,
        status: "ACKNOWLEDGED", outcome: {},
      }),
      () => composed.broker.appendReconciliationEvidence({
        tenantScope: scope, outboxId: "outbox-1", evidenceId: "evidence-1",
        idempotencyKey: "idem-1", providerId: "provider-1",
        observedAt: new Date(now * 1000).toISOString(),
        status: "UNKNOWN", observation: { status: "UNKNOWN" },
      }),
      () => composed.broker.listReconciliationEvidence({
        tenantScope: scope, outboxId: "outbox-1", missionId: "mission-1",
        taskId: "task-1", executionRequestId: "request-1",
      }),
    ];
    for (const invoke of revokedOperations) {
      let denied = false;
      try {
        await invoke();
      } catch (error) {
        denied = error instanceof WorkerBrokerAuthorizationError &&
          error.reason === "PRINCIPAL_NOT_AUTHORIZED";
      }
      assert(denied, "every broker method must recheck and reject a revoked principal");
    }
  }
  assert(Number(brokerCalls) === 2,
    "revocation must block every guarded broker method before any raw broker operation");
  liveRegistration = { ...liveRegistration, enabled: true };

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

  const orchestratedPoll = await configuredOrchestrator.runNextWorkerDispatch({
    tenantScope: {
      workerPrincipalId: "principal-1",
      organizationId: "org-1",
      workspaceId: "ws-1",
      userId: "user-1",
    },
    ownerId: "worker-instance-1",
    leaseMilliseconds: 30_000,
    provider: {
      providerId: "test-provider",
      supportsIdempotencyKeys: true,
      async dispatch() {
        throw new Error("empty queue must not invoke provider");
      },
    },
    now: () => now * 1000,
  });
  assert(orchestratedPoll.status === "NO_PENDING_DISPATCH",
    "mission orchestrator must route worker polling through the durable dispatch runtime");
  assert(Number(brokerCalls) === 3,
    "orchestrated durable poll must call only the guarded broker facade after recovery and claim calls");

  console.log("Worker runtime composition tests: PASS");
}

void run();
