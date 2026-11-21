import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";

function safeNextPath(value: string | null): string {
  if (!value || !value.startsWith("/") || value.startsWith("//") || value.includes("\\")) {
    return "/workspace";
  }

  try {
    const parsed = new URL(value, "https://happy.invalid");
    return parsed.origin === "https://happy.invalid"
      ? `${parsed.pathname}${parsed.search}${parsed.hash}`
      : "/workspace";
  } catch {
    return "/workspace";
  }
}

export async function GET(request: NextRequest) {
  const requestUrl = new URL(request.url);
  const code = requestUrl.searchParams.get("code");
  const nextPath = safeNextPath(requestUrl.searchParams.get("next"));

  if (code) {
    try {
      const supabase = await createClient();
      const { error } = await supabase.auth.exchangeCodeForSession(code);
      if (!error) {
        const response = NextResponse.redirect(new URL(nextPath, requestUrl.origin));
        response.headers.set("Cache-Control", "private, no-store");
        return response;
      }
    } catch {
      // Return a generic failure without exposing Auth provider details.
    }
  }

  const response = NextResponse.redirect(
    new URL("/login?error=auth_callback", requestUrl.origin),
  );
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
