import {
  TrustedWorkerIdentityProvider,
  type VerifiedWorkerCredentialClaims,
} from "../../../core/mission/trusted-worker-identity";
import {
  authorizeWorkerBrokerOperation,
  type WorkerPrincipalRegistry,
} from "../../../core/mission/worker-database-broker";

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
  tokenId: "test-token-1",
  environment: "production",
  capabilities: ["CONTROL", "VERIFY"],
};

async function makeIdentity() {
  const provider = new TrustedWorkerIdentityProvider(
    { getCredential: async () => "opaque-credential" },
    { verifyCredential: async () => claims },
    {
      issuer: claims.issuer,
      audience: "happy-worker-broker",
      environment: "production",
      allowedSubjects: [claims.subject],
      allowedCapabilities: ["CONTROL", "VERIFY"],
      maxCredentialLifetimeSeconds: 600,
    },
    () => now * 1000,
  );
  const result = await provider.getVerifiedWorkerIdentity();
  assert(result.status === "VERIFIED", "test identity must be cryptographically attested by the fake verifier");
  return result.identity;
}

function registry(overrides: Record<string, unknown> = {}): WorkerPrincipalRegistry {
  return {
    findByIssuerSubjectEnvironment: async () => ({
      principalId: "worker-principal-1",
      issuer: claims.issuer,
      subject: claims.subject,
      audience: "happy-worker-broker",
      environment: "production",
      enabled: true,
      capabilities: ["CONTROL", "VERIFY"],
      ...overrides,
    }),
  };
}

async function run() {
  const identity = await makeIdentity();

  const allowed = await authorizeWorkerBrokerOperation({
    identity,
    operation: "claim_task",
    registry: registry(),
    now: () => now * 1000,
  });
  assert(allowed.status === "AUTHORIZED", "enabled matching worker with CONTROL must be authorized");

  const revoked = await authorizeWorkerBrokerOperation({
    identity,
    operation: "claim_task",
    registry: registry({ revokedAt: now - 1 }),
    now: () => now * 1000,
  });
  assert(revoked.status === "DENIED", "revoked registry entry must be denied");

  const disabled = await authorizeWorkerBrokerOperation({
    identity,
    operation: "claim_task",
    registry: registry({ enabled: false }),
    now: () => now * 1000,
  });
  assert(disabled.status === "DENIED", "disabled registry entry must be denied");

  const wrongAudience = await authorizeWorkerBrokerOperation({
    identity,
    operation: "claim_task",
    registry: registry({ audience: "other-audience" }),
    now: () => now * 1000,
  });
  assert(wrongAudience.status === "DENIED", "audience mismatch must be denied");

  const missingCapability = await authorizeWorkerBrokerOperation({
    identity,
    operation: "claim_task",
    registry: registry({ capabilities: ["VERIFY"] }),
    now: () => now * 1000,
  });
  assert(missingCapability.status === "DENIED", "registry capability mismatch must be denied");

  const wrongOperation = await authorizeWorkerBrokerOperation({
    identity,
    operation: "append_reconciliation_evidence",
    registry: registry({ capabilities: ["CONTROL"] }),
    now: () => now * 1000,
  });
  assert(wrongOperation.status === "DENIED", "CONTROL-only worker must not invoke VERIFY operation");

  const expired = await authorizeWorkerBrokerOperation({
    identity,
    operation: "claim_task",
    registry: registry(),
    now: () => (now + 301) * 1000,
  });
  assert(expired.status === "DENIED", "expired attested identity must be denied");

  const forged = await authorizeWorkerBrokerOperation({
    identity: { ...identity },
    operation: "claim_task",
    registry: registry(),
    now: () => now * 1000,
  });
  assert(forged.status === "DENIED", "copied plain object must not preserve private identity attestation");

  const unavailable = await authorizeWorkerBrokerOperation({
    identity,
    operation: "claim_task",
    registry: null,
    now: () => now * 1000,
  });
  assert(unavailable.status === "NOT_CONNECTED", "missing registry must remain NOT_CONNECTED");

  let registryCalls = 0;
  const outage = await authorizeWorkerBrokerOperation({
    identity,
    operation: "claim_task",
    registry: {
      findByIssuerSubjectEnvironment: async () => {
        registryCalls += 1;
        throw new Error("registry unavailable");
      },
    },
    now: () => now * 1000,
  });
  assert(outage.status === "DENIED" && registryCalls === 1, "registry outage must fail closed");
}

void run();
