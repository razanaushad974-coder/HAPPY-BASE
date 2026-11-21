import assert from "node:assert/strict";

import { getSupabasePublicEnvironment } from "../../../lib/supabase/env";

const urlKey = "NEXT_PUBLIC_SUPABASE_URL";
const publishableKey = "NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY";
const previousUrl = process.env[urlKey];
const previousKey = process.env[publishableKey];

function configure(url: string | undefined, key: string | undefined) {
  if (url === undefined) delete process.env[urlKey];
  else process.env[urlKey] = url;
  if (key === undefined) delete process.env[publishableKey];
  else process.env[publishableKey] = key;
}

function rejects(code: string) {
  assert.throws(() => getSupabasePublicEnvironment(), (error: unknown) =>
    error instanceof Error && error.message.startsWith(code),
  );
}

try {
  configure(undefined, undefined);
  rejects("SUPABASE_NOT_CONFIGURED");

  configure("not-a-url", "sb_publishable_test-key");
  rejects("SUPABASE_URL_INVALID");

  configure("http://example.com", "sb_publishable_test-key");
  rejects("SUPABASE_URL_MUST_USE_HTTPS");

  configure("https://user:pass@example.com", "sb_publishable_test-key");
  rejects("SUPABASE_URL_INVALID");

  configure("https://project.supabase.co", "invalid key with spaces");
  rejects("SUPABASE_PUBLISHABLE_KEY_INVALID");

  configure("http://localhost:54321/", "sb_publishable_test-key");
  const local = getSupabasePublicEnvironment();
  assert.equal(local.url, "http://localhost:54321");
  assert.equal(local.publishableKey, "sb_publishable_test-key");

  configure("https://project.supabase.co/", "sb_publishable_test-key");
  const remote = getSupabasePublicEnvironment();
  assert.equal(remote.url, "https://project.supabase.co");
  assert.equal(remote.publishableKey, "sb_publishable_test-key");
} finally {
  configure(previousUrl, previousKey);
}

console.log("Supabase public environment contracts passed.");
