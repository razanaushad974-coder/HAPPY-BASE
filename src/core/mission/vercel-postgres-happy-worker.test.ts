import assert from "node:assert/strict";
import { generateKeyPairSync } from "node:crypto";

import { createVercelPostgresHappyWorker } from "./vercel-postgres-happy-worker";
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

console.log("Vercel PostgreSQL HAPPY worker entrypoint: PASS");
