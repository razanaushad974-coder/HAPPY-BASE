import { createSign, generateKeyPairSync } from "node:crypto";
import { JwksOidcWorkerCredentialVerifier } from "../../../core/mission/jwks-oidc-worker-credential-verifier";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const now = 1_800_000_000;
const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });
const jwk = publicKey.export({ format: "jwk" });
const config = {
  issuer: "https://issuer.example.test",
  audience: "happy-execution",
  jwksUri: "https://issuer.example.test/.well-known/jwks.json",
  environment: "staging",
  capabilities: ["API", "VERIFY"] as const,
  now: () => now * 1000,
};

function token(claims: Record<string, unknown>, header: Record<string, unknown> = { alg: "RS256", kid: "key-1", typ: "JWT" }) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url");
  const input = encode(header) + "." + encode(claims);
  const signer = createSign("RSA-SHA256");
  signer.update(input);
  signer.end();
  return input + "." + signer.sign(privateKey).toString("base64url");
}

const validClaims = {
  iss: config.issuer,
  sub: "owner:team:project:happy-worker:environment:staging",
  aud: config.audience,
  iat: now - 20,
  nbf: now - 20,
  exp: now + 240,
  jti: "jti-001",
};

async function main() {
  let fetchCount = 0;
  const verifier = new JwksOidcWorkerCredentialVerifier(config, async () => {
    fetchCount++;
    return { ok: true, status: 200, async json() { return { keys: [{ ...jwk, kid: "key-1", use: "sig", alg: "RS256" }] }; } };
  });

  const accepted = await verifier.verifyCredential(token(validClaims));
  assert(accepted?.subject === validClaims.sub, "valid signed OIDC credential rejected");
  assert(accepted?.capabilities.join(",") === "API,VERIFY", "server-owned capabilities not applied");
  assert(fetchCount === 1, "JWKS should be fetched once and cached");

  assert(await verifier.verifyCredential(token({ ...validClaims, iss: "https://attacker.test" })) === null,
    "wrong issuer accepted");
  assert(await verifier.verifyCredential(token({ ...validClaims, aud: "other" })) === null,
    "wrong audience accepted");
  assert(await verifier.verifyCredential(token({ ...validClaims, exp: now - 100 })) === null,
    "expired credential accepted");
  assert(await verifier.verifyCredential(token({ ...validClaims, nbf: now + 100 })) === null,
    "not-yet-valid credential accepted");
  assert(await verifier.verifyCredential(token(validClaims, { alg: "none", kid: "key-1" })) === null,
    "non-RS256 algorithm accepted");

  const invalidSignature = token(validClaims).slice(0, -4) + "AAAA";
  assert(await verifier.verifyCredential(invalidSignature) === null, "invalid signature accepted");

  let rotationFetches = 0;
  const rotated = new JwksOidcWorkerCredentialVerifier(config, async () => {
    rotationFetches++;
    return { ok: true, status: 200, async json() { return { keys: [{ ...jwk, kid: "rotated", use: "sig", alg: "RS256" }] }; } };
  });
  assert(await rotated.verifyCredential(token(validClaims, { alg: "RS256", kid: "rotated" })) !== null,
    "rotated JWKS key was not loaded");
  assert(rotationFetches === 1, "unknown kid should trigger JWKS refresh");

  const unavailable = new JwksOidcWorkerCredentialVerifier(config, async () => ({
    ok: false, status: 503, async json() { return {}; },
  }));
  assert(await unavailable.verifyCredential(token(validClaims)) === null, "JWKS outage did not fail closed");

  console.log("JWKS OIDC worker credential verifier tests: PASS");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
