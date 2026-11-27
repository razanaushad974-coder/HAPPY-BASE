import { createPublicKey, verify as verifySignature } from "node:crypto";

const required = [
  "ACTIONS_ID_TOKEN_REQUEST_URL",
  "ACTIONS_ID_TOKEN_REQUEST_TOKEN",
  "GITHUB_REPOSITORY",
  "GITHUB_REPOSITORY_ID",
  "GITHUB_REPOSITORY_OWNER_ID",
  "GITHUB_REF",
  "GITHUB_WORKFLOW_REF",
];
for (const key of required) {
  if (!process.env[key]) throw new Error(`Missing required GitHub Actions OIDC variable: ${key}`);
}

const expected = {
  issuer: "https://token.actions.githubusercontent.com",
  audience: "happy-staging-worker",
  repository: "razanaushad974-coder/HAPPY-BASE",
  repositoryId: "1368712889",
  ownerId: "285602201",
  ref: "refs/heads/docs/staging-worker-activation-runbook",
  workflowRef: "razanaushad974-coder/HAPPY-BASE/.github/workflows/happy-staging-worker-oidc-preflight.yml@refs/heads/docs/staging-worker-activation-runbook",
  subject: "repo:razanaushad974-coder/HAPPY-BASE:environment:happy-staging-worker",
  environment: "happy-staging-worker",
};

if (
  process.env.GITHUB_REPOSITORY !== expected.repository ||
  process.env.GITHUB_REPOSITORY_ID !== expected.repositoryId ||
  process.env.GITHUB_REPOSITORY_OWNER_ID !== expected.ownerId ||
  process.env.GITHUB_REF !== expected.ref ||
  process.env.GITHUB_WORKFLOW_REF !== expected.workflowRef
) {
  throw new Error("GitHub runner repository/ref/workflow context does not match the pinned staging worker.");
}

const endpoint = new URL(process.env.ACTIONS_ID_TOKEN_REQUEST_URL);
endpoint.searchParams.set("audience", expected.audience);
const tokenResponse = await fetch(endpoint, {
  headers: { Authorization: `bearer ${process.env.ACTIONS_ID_TOKEN_REQUEST_TOKEN}` },
  signal: AbortSignal.timeout(10_000),
});
if (!tokenResponse.ok) throw new Error(`GitHub OIDC token request failed: HTTP ${tokenResponse.status}`);
const tokenBody = await tokenResponse.json();
if (typeof tokenBody?.value !== "string" || !tokenBody.value) {
  throw new Error("GitHub OIDC endpoint returned no token.");
}
const token = tokenBody.value;
const parts = token.split(".");
if (parts.length !== 3 || parts.some((part) => !part)) throw new Error("Malformed OIDC JWT.");

function decodePart(value) {
  if (!/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Invalid JWT base64url segment.");
  return Buffer.from(value, "base64url");
}
function parseObject(value) {
  const parsed = JSON.parse(decodePart(value).toString("utf8"));
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error("JWT segment is not a JSON object.");
  }
  return parsed;
}
const header = parseObject(parts[0]);
if (header.alg !== "RS256" || typeof header.kid !== "string" || !header.kid ||
    header.jku !== undefined || header.x5u !== undefined ||
    (header.crit !== undefined && (!Array.isArray(header.crit) || header.crit.length !== 0))) {
  throw new Error("OIDC JWT header is not an accepted RS256/JWKS header.");
}

const jwksResponse = await fetch("https://token.actions.githubusercontent.com/.well-known/jwks", {
  signal: AbortSignal.timeout(10_000),
});
if (!jwksResponse.ok) throw new Error(`GitHub OIDC JWKS fetch failed: HTTP ${jwksResponse.status}`);
const jwks = await jwksResponse.json();
if (!Array.isArray(jwks?.keys) || jwks.keys.length < 1 || jwks.keys.length > 64) {
  throw new Error("GitHub OIDC JWKS document is invalid.");
}
const matchingKeys = jwks.keys.filter((key) => key?.kid === header.kid && key?.kty === "RSA" &&
  (key.use === undefined || key.use === "sig") && (key.alg === undefined || key.alg === "RS256"));
if (matchingKeys.length !== 1) throw new Error("OIDC signing key is missing or ambiguous.");
const publicKey = createPublicKey({ key: matchingKeys[0], format: "jwk" });
const validSignature = verifySignature(
  "RSA-SHA256",
  Buffer.from(`${parts[0]}.${parts[1]}`, "utf8"),
  publicKey,
  decodePart(parts[2]),
);
if (!validSignature) throw new Error("GitHub OIDC signature verification failed.");

const claims = parseObject(parts[1]);
const now = Math.floor(Date.now() / 1000);
const audiences = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
if (
  claims.iss !== expected.issuer ||
  !audiences.includes(expected.audience) ||
  claims.sub !== expected.subject ||
  claims.repository !== expected.repository ||
  String(claims.repository_id) !== expected.repositoryId ||
  String(claims.repository_owner_id) !== expected.ownerId ||
  claims.ref !== expected.ref ||
  claims.workflow_ref !== expected.workflowRef ||
  claims.environment !== expected.environment ||
  claims.event_name !== "push" && claims.event_name !== "workflow_dispatch" ||
  !Number.isSafeInteger(claims.iat) ||
  !Number.isSafeInteger(claims.nbf) ||
  !Number.isSafeInteger(claims.exp) ||
  claims.iat > now + 30 ||
  claims.nbf > now + 30 ||
  claims.exp <= now ||
  claims.exp <= claims.iat ||
  claims.exp - claims.iat > 600
) {
  throw new Error("Verified JWT claims do not match the exact HAPPY staging worker policy.");
}

console.log("HAPPY_STAGING_GITHUB_OIDC_PREFLIGHT=PASS");
console.log(`issuer=${claims.iss}`);
console.log(`subject=${claims.sub}`);
console.log(`audience=${expected.audience}`);
console.log(`repository_id=${claims.repository_id}`);
console.log(`environment=${claims.environment}`);
console.log("database_connected=false");
console.log("worker_dispatch_executed=false");
