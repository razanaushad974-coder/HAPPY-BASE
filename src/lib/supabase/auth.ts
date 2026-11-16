import type { JwtPayload } from "@supabase/supabase-js";

import { createClient } from "./server";

export interface VerifiedSupabaseIdentity {
  userId: string;
  claims: JwtPayload;
}

/**
 * Returns an identity only after Supabase verifies the JWT signature.
 * Never use user_metadata for authorization or tenant membership.
 */
export async function getVerifiedIdentity(): Promise<VerifiedSupabaseIdentity | null> {
  const supabase = await createClient();
  const { data, error } = await supabase.auth.getClaims();

  if (error || !data?.claims || typeof data.claims.sub !== "string") {
    return null;
  }

  return {
    userId: data.claims.sub,
    claims: data.claims,
  };
}

export async function requireVerifiedIdentity(): Promise<VerifiedSupabaseIdentity> {
  const identity = await getVerifiedIdentity();

  if (!identity) {
    throw new Error("AUTHENTICATION_REQUIRED");
  }

  return identity;
}
