import {
  SupabaseVerifiedServerIdentityProvider,
  type SupabaseServerAuthClient,
} from "../../../core/tenant/supabase-verified-server-identity-provider";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

async function main(): Promise<void> {
  let calls = 0;
  const verifiedClient = {
    auth: {
      async getUser() {
        calls += 1;
        return { data: { user: { id: "verified-user-1" } }, error: null };
      },
    },
  } satisfies SupabaseServerAuthClient;

  const provider = new SupabaseVerifiedServerIdentityProvider(verifiedClient);
  const identity = await provider.getVerifiedIdentity();
  assert(identity?.userId === "verified-user-1", "Verified Supabase user ID was not returned.");
  assert(calls === 1, "Supabase getUser() must be called exactly once per identity lookup.");

  const rejected = new SupabaseVerifiedServerIdentityProvider({
    auth: { async getUser() { return { data: { user: null }, error: { message: "invalid token" } }; } },
  });
  assert(await rejected.getVerifiedIdentity() === null, "Supabase Auth error did not fail closed.");

  const missingId = new SupabaseVerifiedServerIdentityProvider({
    auth: { async getUser() { return { data: { user: { id: "  " } }, error: null }; } },
  });
  assert(await missingId.getVerifiedIdentity() === null, "Blank Supabase user ID was accepted.");

  const malformedId = new SupabaseVerifiedServerIdentityProvider({
    auth: { async getUser() { return { data: { user: { id: 123 } }, error: null }; } },
  });
  assert(await malformedId.getVerifiedIdentity() === null, "Non-string Supabase user ID was accepted.");

  const unavailable = new SupabaseVerifiedServerIdentityProvider({
    auth: { async getUser() { throw new Error("auth service unavailable"); } },
  });
  assert(await unavailable.getVerifiedIdentity() === null, "Thrown auth failure did not fail closed.");

  console.log("Supabase verified server identity contract: PASS");
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
