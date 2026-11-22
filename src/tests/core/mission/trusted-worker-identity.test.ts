import {
  TrustedWorkerIdentityProvider,
  type VerifiedWorkerCredentialClaims,
  type WorkerCapability,
} from "../../../core/mission/trusted-worker-identity";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const now = 1_800_000_000;
const valid: VerifiedWorkerCredentialClaims = {
  issuer: "https://identity.example.test",
  subject: "workload:happy-dispatcher",
  audience: "happy-execution",
  issuedAt: now - 30,
  notBefore: now - 30,
  expiresAt: now + 240,
  tokenId: "token-unique-1",
  environment: "staging",
  capabilities: ["API", "VERIFY"],
};

const policy = {
  issuer: "https://identity.example.test",
  audience: "happy-execution",
  environment: "staging",
  allowedSubjects: ["workload:happy-dispatcher"],
  allowedCapabilities: ["API", "VERIFY"] as WorkerCapability[],
  maxCredentialLifetimeSeconds: 300,
  clockSkewSeconds: 15,
};

async function resolve(
  claims: VerifiedWorkerCredentialClaims | null,
  options: { credential?: string | null; throws?: boolean } = {},
) {
  return new TrustedWorkerIdentityProvider(
    { async getCredential() { return options.credential === undefined ? "opaque-platform-credential" : options.credential; } },
    { async verifyCredential() {
      if (options.throws) throw new Error("identity verifier unavailable");
      return claims;
    } },
    policy,
    () => now * 1000,
  ).getVerifiedWorkerIdentity();
}

async function main(): Promise<void> {
  const accepted = await resolve(valid);
  assert(accepted.status === "VERIFIED", "valid platform-attested workload was rejected");
  if (accepted.status === "VERIFIED") {
    assert(accepted.identity.principal === valid.subject, "worker principal mismatch");
    assert(accepted.identity.capabilities.join(",") === "API,VERIFY", "capability binding mismatch");
  }

  assert((await new TrustedWorkerIdentityProvider(null, null, policy).getVerifiedWorkerIdentity()).status === "NOT_CONNECTED",
    "missing runtime provider must remain NOT_CONNECTED");
  assert((await resolve(valid, { credential: null })).status === "DENIED", "missing credential was accepted");
  assert((await resolve(null)).status === "DENIED", "unverified credential was accepted");
  assert((await resolve(valid, { throws: true })).status === "DENIED", "verifier outage did not fail closed");

  const cases: Array<[string, Partial<VerifiedWorkerCredentialClaims>]> = [
    ["wrong issuer", { issuer: "https://attacker.invalid" }],
    ["wrong audience", { audience: "other-service" }],
    ["human subject", { subject: "user:123" }],
    ["unapproved subject", { subject: "workload:unknown" }],
    ["wrong environment", { environment: "production" }],
    ["expired", { expiresAt: now - 100 }],
    ["not yet valid", { notBefore: now + 100 }],
    ["future issued", { issuedAt: now + 100 }],
    ["excessive lifetime", { expiresAt: now + 600 }],
    ["missing token id", { tokenId: "" }],
    ["unapproved capability", { capabilities: ["DEPLOY"] }],
    ["duplicate capability", { capabilities: ["API", "API"] }],
    ["empty capability", { capabilities: [] }],
  ];
  for (const [label, patch] of cases) {
    const result = await resolve({ ...valid, ...patch });
    assert(result.status === "DENIED", `${label} identity was accepted`);
  }

  console.log("Trusted worker identity contract tests: PASS");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
