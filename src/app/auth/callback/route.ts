import { NextResponse, type NextRequest } from "next/server";

import { createClient } from "@/lib/supabase/server";

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
      // Fall through to the generic sign-in error redirect.
    }
  }

  const response = NextResponse.redirect(
    new URL("/login?error=auth_callback", requestUrl.origin),
  );
  response.headers.set("Cache-Control", "private, no-store");
  return response;
}
