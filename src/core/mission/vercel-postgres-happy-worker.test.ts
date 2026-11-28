import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import {
  createVercelPostgresHappyWorker,
  createVercelPostgresHappyWorkerFromEnvironment,
} from "./vercel-postgres-happy-worker";
import type { PgPoolLike } from "../persistence/adapters/postgres-tenant-adapter";
import type { AsyncTenantPersistenceAdapter } from "../persistence/async-tenant-repository";
import type { IdempotentDispatchProvider } from "./durable-dispatch-worker-contract";

const provider: IdempotentDispatchProvider = {
  providerId: "test-provider",
  supportsIdempotencyKeys: true,
  async dispatch() {
    return {
      kind: "ACKNOWLEDGED",
      provider: "test-provider",
      providerRequestId: "request-1",
      response: {},
    };
  },
};

const runtime = {
  tokenReader: async () => "test-only-token",
  jwks: {
    issuer: "https://oidc.example.test",
    audience: "happy-worker",
    jwksUri: "https://oidc.example.test/.well-known/jwks.json",
    environment: "preview",
    expectedSubject: "owner/project/worker",
    expectedWorkloadClaims: {
      ownerId: "owner",
      projectId: "project",
      environment: "preview",
    },
    maxTokenLifetimeSeconds: 300,
    capabilities: ["CONTROL", "VERIFY"] as const,
  },
  database: {
    pool: {} as unknown as PgPoolLike,
    expectedLoginRole: "happy_worker_preview",
  },
};

const tenantPersistence = {} as unknown as AsyncTenantPersistenceAdapter;

assert.throws(
  () => createVercelPostgresHappyWorker({
    runtime,
    tenantPersistence,
    provider,
    leaseMilliseconds: 4_999,
  }),
  /Worker lease must be between/,
);

const worker = createVercelPostgresHappyWorker({
  runtime,
  tenantPersistence,
  provider,
});

assert.equal(typeof worker.runOneReadyTask, "function");
assert.equal(typeof worker.runOnePendingDispatch, "function");
const tenantServices = worker.createTenantVerificationServices({
  organizationId: "org-test",
  workspaceId: "workspace-test",
  userId: "user-test",
});
assert.equal(typeof tenantServices.evidence.capture, "function");
assert.equal(typeof tenantServices.verification.registerRequest, "function");
assert.equal(typeof tenantServices.verification.verifyWithExternalVerifier, "function");
assert.equal(typeof worker.transitionTaskDurable, "function");
assert.equal(typeof worker.verifyTenantRequest, "function");
assert.equal(typeof worker.assessTenantMissionRecovery, "function");
assert.throws(
  () => worker.createTenantVerificationServices({
    organizationId: "org-test",
    workspaceId: "workspace-test",
    userId: "",
  }),
  /Complete organization, workspace, and user scope/,
);
assert.equal(worker.semanticVerifier.status, "NOT_CONFIGURED");
assert.equal(worker.semanticVerifier.client, null);
assert.equal(worker.semanticVerifier.authority, null);

assert.throws(
  () => createVercelPostgresHappyWorker({
    runtime,
    tenantPersistence,
    provider,
    semanticVerifierEndpoint: "https://verifier.example.test/evaluate",
  }),
  /must be configured together/,
);
assert.throws(
  () => createVercelPostgresHappyWorker({
    runtime,
    tenantPersistence,
    provider,
    semanticVerifierEndpoint: "https://verifier.example.test/evaluate",
    readSemanticVerifierBearerToken: async () => "server-only-test-token",
  }),
  /trusted public-key allowlist/,
);

const { publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const configuredWorker = createVercelPostgresHappyWorker({
  runtime,
  tenantPersistence,
  provider,
  semanticVerifierEndpoint: "https://verifier.example.test/evaluate",
  readSemanticVerifierBearerToken: async () => "server-only-test-token",
  semanticVerifierKeysJson: JSON.stringify([{
    verifierId: "verifier-test",
    keyId: "key-test",
    publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
  }]),
});
assert.equal(configuredWorker.semanticVerifier.status, "CONFIGURED");
assert.ok(configuredWorker.semanticVerifier.client);
assert.ok(configuredWorker.semanticVerifier.authority);

const environmentWorker = createVercelPostgresHappyWorkerFromEnvironment({
  runtime,
  tenantPersistence,
  provider,
  environment: {
    HAPPY_SEMANTIC_VERIFIER_ENDPOINT: "https://verifier.example.test/evaluate",
    HAPPY_SEMANTIC_VERIFIER_KEYS: JSON.stringify([{
      verifierId: "verifier-test",
      keyId: "key-test",
      publicKeyPem: publicKey.export({ type: "spki", format: "pem" }),
    }]),
  },
  readSemanticVerifierBearerToken: async () => "server-only-test-token",
});
assert.equal(environmentWorker.semanticVerifier.status, "CONFIGURED");
assert.throws(
  () => createVercelPostgresHappyWorkerFromEnvironment({
    runtime,
    tenantPersistence,
    provider,
    environment: {
      HAPPY_SEMANTIC_VERIFIER_ENDPOINT: "https://verifier.example.test/evaluate",
    },
  }),
  /must be configured together/,
);

void (async () => {
  await assert.rejects(
    worker.assessTenantMissionRecovery({
      scope: { organizationId: "org-a", workspaceId: "workspace-a", userId: "user-a" },
      workerScope: { workerPrincipalId: "worker-a", organizationId: "org-b", workspaceId: "workspace-a", userId: "user-a" },
      missionId: "mission-test",
    }),
    /same tenant scope/,
  );
  assert.throws(
    () => worker.verifyTenantRequest({
      scope: { organizationId: "org-test", workspaceId: "workspace-test", userId: "user-test" },
      requestId: "verification-request-test",
      evidenceIds: Array.from({ length: 51 }, (_, index) => `evidence-${index}`),
    }),
    /1 to 50 bounded evidence IDs/,
  );
  const verifyTenantRequest = worker.verifyTenantRequest;
  await assert.rejects(
    verifyTenantRequest({
      scope: { organizationId: "org-test", workspaceId: "workspace-test", userId: "user-test" },
      requestId: "verification-request-test",
      evidenceIds: ["evidence-test"],
    }),
    /TRUSTED_SEMANTIC_VERIFIER_NOT_CONFIGURED/,
  );
  console.log("Vercel PostgreSQL HAPPY worker entrypoint: PASS");
})();
