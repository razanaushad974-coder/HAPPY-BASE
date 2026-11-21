import { createServerClient } from "@supabase/ssr";
import { NextResponse, type NextRequest } from "next/server";

import { getSupabasePublicEnvironment } from "./env";

export async function updateSession(request: NextRequest) {
  let supabaseResponse = NextResponse.next({ request });
  let environment: ReturnType<typeof getSupabasePublicEnvironment>;

  try {
    environment = getSupabasePublicEnvironment();
  } catch (error) {
    if (error instanceof Error && error.message.startsWith("SUPABASE_NOT_CONFIGURED:")) {
      return supabaseResponse;
    }
    throw error;
  }

  const supabase = createServerClient(environment.url, environment.publishableKey, {
    cookies: {
      getAll() {
        return request.cookies.getAll();
      },
      setAll(cookiesToSet, headers) {
        cookiesToSet.forEach(({ name, value }) => request.cookies.set(name, value));
        supabaseResponse = NextResponse.next({ request });
        cookiesToSet.forEach(({ name, value, options }) => {
          supabaseResponse.cookies.set(name, value, options);
        });
        Object.entries(headers).forEach(([key, value]) => {
          supabaseResponse.headers.set(key, value);
        });
      },
    },
  });

  // Refresh only. Every protected page and route must independently verify claims.
  await supabase.auth.getClaims();
  return supabaseResponse;
}
