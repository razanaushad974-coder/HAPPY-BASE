import { VercelOidcWorkerCredentialSource } from "../../../core/mission/vercel-oidc-worker-credential-source";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  let calls = 0;
  const source = new VercelOidcWorkerCredentialSource(async () => {
    calls += 1;
    return `short-lived-vercel-token-${calls}`;
  });

  const first = await source.getCredential();
  const second = await source.getCredential();
  assert(first === "short-lived-vercel-token-1", "first platform token was not returned");
  assert(second === "short-lived-vercel-token-2", "token source must re-read on every call");
  assert(calls === 2, "Vercel OIDC credentials must never be cached");

  const missing = new VercelOidcWorkerCredentialSource(async () => "");
  assert(await missing.getCredential() === null, "empty platform token must fail closed");

  const unavailable = new VercelOidcWorkerCredentialSource(async () => {
    throw new Error("request context unavailable");
  });
  assert(await unavailable.getCredential() === null, "platform token source failure must fail closed");

  console.log("Vercel OIDC worker credential source tests: PASS");
}

void main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
