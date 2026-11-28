import assert from "node:assert/strict";
import { PostgresWorkerTenantGrantSource } from "./postgres-worker-tenant-grant-source";
import { TrustedWorkerIdentityProvider } from "./trusted-worker-identity";
import type { WorkerDatabaseSessionProvider } from "./postgres-worker-database-broker";
import type { PgQueryable } from "../persistence/adapters/postgres-tenant-adapter";

async function main(): Promise<void> {
  const fixedNow = 1_800_000_000_000;
  const identityProvider = new TrustedWorkerIdentityProvider(
    { async getCredential() { return "test-workload-credential"; } },
    {
      async verifyCredential() {
        return {
          issuer: "https://identity.example.test",
          subject: "node-worker:staging",
          audience: "happy-worker",
          issuedAt: 1_799_999_990,
          notBefore: 1_799_999_990,
          expiresAt: 1_800_000_060,
          tokenId: "tenant-grant-test-token",
          environment: "staging",
          capabilities: ["CONTROL"],
        };
      },
    },
    {
      issuer: "https://identity.example.test",
      audience: "happy-worker",
      environment: "staging",
      allowedSubjects: ["node-worker:staging"],
      allowedCapabilities: ["CONTROL"],
      maxCredentialLifetimeSeconds: 120,
    },
    () => fixedNow,
  );
  const identityResolution = await identityProvider.getVerifiedWorkerIdentity();
  assert.equal(identityResolution.status, "VERIFIED");
  if (identityResolution.status !== "VERIFIED") throw new Error("test identity unavailable");
  const identity = identityResolution.identity;
  const registration = Object.freeze({
    principalId: "11111111-1111-4111-8111-111111111111",
    issuer: identity.issuer,
    subject: identity.principal,
    audience: identity.audience,
    environment: identity.environment,
    enabled: true,
    capabilities: Object.freeze(["CONTROL" as const]),
    revokedAt: null,
  });
  
  let calls = 0;
  let lastSql = "";
  let lastValues: readonly unknown[] = [];
  const sessions: WorkerDatabaseSessionProvider = {
    async withTransaction<T>(operation: (client: PgQueryable) => Promise<T>): Promise<T> {
      return operation({
        async query(sql: string, values: readonly unknown[] = []) {
          calls += 1;
          lastSql = sql;
          lastValues = values;
          return {
            rows: [{
              organization_id: "22222222-2222-4222-8222-222222222222",
              workspace_id: "33333333-3333-4333-8333-333333333333",
              user_id: "44444444-4444-4444-8444-444444444444",
            }],
          };
        },
      } as unknown as PgQueryable);
    },
  };
  const source = new PostgresWorkerTenantGrantSource(sessions);
  const result = await source.nextAuthorizedTenant({
    identity,
    registration,
    cursor: null,
  });
  assert.ok(result);
  assert.equal(result.scope.organizationId, "22222222-2222-4222-8222-222222222222");
  assert.equal(result.scope.workspaceId, "33333333-3333-4333-8333-333333333333");
  assert.equal(result.scope.userId, "44444444-4444-4444-8444-444444444444");
  assert.equal(result.workerScope.workerPrincipalId, registration.principalId);
  assert.equal(result.nextCursor, [
    "22222222-2222-4222-8222-222222222222",
    "33333333-3333-4333-8333-333333333333",
    "44444444-4444-4444-8444-444444444444",
  ].join("|"));
  assert.match(lastSql, /private\.happy_worker_list_tenant_grants/);
  assert.deepEqual(lastValues, [registration.principalId, null, null, null, 1]);
  
  await assert.rejects(
    () => source.nextAuthorizedTenant({
      identity,
      registration: { ...registration, subject: "node-worker:other" },
      cursor: null,
    }),
    /WORKER_TENANT_GRANT_IDENTITY_MISMATCH/,
  );
  assert.equal(calls, 1, "identity mismatch must fail before database access");
  
  await assert.rejects(
    () => source.nextAuthorizedTenant({
      identity,
      registration,
      cursor: "not-a-cursor",
    }),
    /Invalid worker tenant grant cursor/,
  );
  assert.equal(calls, 1, "malformed cursor must fail before database access");
  
  console.log("PostgreSQL worker tenant grant source: PASS");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
