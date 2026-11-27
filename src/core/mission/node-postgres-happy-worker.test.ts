import assert from "node:assert/strict";

import type { PgPoolLike } from "../persistence/adapters/postgres-tenant-adapter";
import type { AsyncTenantPersistenceAdapter } from "../persistence/async-tenant-repository";
import type { IdempotentDispatchProvider, TrustedWorkerIdentityResolver } from "./durable-dispatch-worker-contract";
import {
  createNodePostgresHappyWorker,
  createNodePostgresWorkerRuntimeDependencies,
} from "./node-postgres-happy-worker";

let connectCalls = 0;
const pool: PgPoolLike = {
  async connect() {
    connectCalls += 1;
    throw new Error("The construction test must never open a database connection.");
  },
};
const identityProvider: TrustedWorkerIdentityResolver = {
  async getVerifiedWorkerIdentity() {
    return { status: "NOT_CONNECTED" };
  },
};
const nodeIdentityResolver = createNodeTrustedWorkerIdentityResolver({
  credentialSource: { async getCredential() { return "platform-issued-test-token"; } },
  credentialVerifier: {
    async verifyCredential() {
      return {
        issuer: "https://issuer.example.test",
        subject: "node-worker:test",
        audience: "happy-worker",
        issuedAt: 1_799_999_900,
        notBefore: 1_799_999_900,
        expiresAt: 1_800_000_100,
        tokenId: "test-jti",
        environment: "staging",
        capabilities: ["CONTROL", "VERIFY"],
      };
    },
  },
  policy: {
    issuer: "https://issuer.example.test",
    audience: "happy-worker",
    environment: "staging",
    allowedSubjects: ["node-worker:test"],
    allowedCapabilities: ["CONTROL", "VERIFY"],
    maxCredentialLifetimeSeconds: 300,
  },
  now: () => 1_800_000_000_000,
});
const verifiedNodeIdentity = await nodeIdentityResolver.getVerifiedWorkerIdentity();
assert.equal(verifiedNodeIdentity.status, "VERIFIED");
if (verifiedNodeIdentity.status === "VERIFIED") {
  assert.equal(verifiedNodeIdentity.identity.principal, "node-worker:test");
  assert.deepEqual(verifiedNodeIdentity.identity.capabilities, ["CONTROL", "VERIFY"]);
}

const provider: IdempotentDispatchProvider = {
  providerId: "node-bootstrap-test-provider",
  supportsIdempotencyKeys: true,
  async dispatch() {
    return {
      kind: "ACKNOWLEDGED",
      provider: "node-bootstrap-test-provider",
      providerRequestId: "request-test",
      response: {},
    };
  },
};
const tenantPersistence = {} as unknown as AsyncTenantPersistenceAdapter;
const runtime = {
  identityProvider,
  pool,
  expectedLoginRole: "happy_worker_staging",
};

const dependencies = createNodePostgresWorkerRuntimeDependencies(runtime);
assert.ok(dependencies.identityProvider);
assert.ok(dependencies.principalRegistry);
assert.ok(dependencies.databaseBroker);
assert.equal(connectCalls, 0, "composition must not claim or open a live database session");

assert.throws(
  () => createNodePostgresWorkerRuntimeDependencies({
    ...runtime,
    expectedLoginRole: "service_role",
  }),
  /WORKER_DATABASE_ROLE_NOT_CONFIGURED/,
);
assert.throws(
  () => createNodePostgresWorkerRuntimeDependencies({
    ...runtime,
    expectedLoginRole: "happy_worker_staging",
    pool: {} as PgPoolLike,
  }),
  /trusted identity resolver and a real PostgreSQL pool/,
);

const worker = createNodePostgresHappyWorker({
  runtime,
  tenantPersistence,
  provider,
});
assert.equal(typeof worker.runOneReadyTask, "function");
assert.equal(typeof worker.runOnePendingDispatch, "function");
assert.equal(typeof worker.assessTenantMissionRecovery, "function");
assert.equal(worker.semanticVerifier.status, "NOT_CONFIGURED");
assert.equal(connectCalls, 0, "worker construction must not contact PostgreSQL");

const environmentWorker = createNodePostgresHappyWorker({
  runtime,
  tenantPersistence,
  provider,
  semanticVerifierKeysJson: undefined,
});
assert.equal(environmentWorker.semanticVerifier.status, "NOT_CONFIGURED");
assert.equal(connectCalls, 0);

console.log("Host-independent Node PostgreSQL HAPPY worker bootstrap: PASS");
