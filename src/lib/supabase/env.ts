export interface SupabasePublicEnvironment {
  url: string;
  publishableKey: string;
}

export function getSupabasePublicEnvironment(): SupabasePublicEnvironment {
  const url = process.env.NEXT_PUBLIC_SUPABASE_URL?.trim();
  const publishableKey =
    process.env.NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY?.trim();

  if (!url || !publishableKey) {
    throw new Error(
      "SUPABASE_NOT_CONFIGURED: Set NEXT_PUBLIC_SUPABASE_URL and NEXT_PUBLIC_SUPABASE_PUBLISHABLE_KEY.",
    );
  }

  let parsedUrl: URL;

  try {
    parsedUrl = new URL(url);
  } catch {
    throw new Error("SUPABASE_URL_INVALID");
  }

  if (
    parsedUrl.protocol !== "https:" &&
    parsedUrl.hostname !== "localhost"
  ) {
    throw new Error("SUPABASE_URL_MUST_USE_HTTPS");
  }

  if (!/^(sb_publishable_[A-Za-z0-9_-]+|[A-Za-z0-9._-]+)$/.test(publishableKey)) {
    throw new Error("SUPABASE_PUBLISHABLE_KEY_INVALID");
  }

  return { url: parsedUrl.toString().replace(/\/$/, ""), publishableKey };
}
