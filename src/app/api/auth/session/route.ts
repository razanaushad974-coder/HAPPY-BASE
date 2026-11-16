import { NextResponse } from "next/server";

import { getVerifiedIdentity } from "@/lib/supabase/auth";

export const dynamic = "force-dynamic";

export async function GET() {
  try {
    const identity = await getVerifiedIdentity();

    return NextResponse.json(
      { status: identity ? "AUTHENTICATED" : "UNAUTHENTICATED" },
      { headers: { "Cache-Control": "private, no-store" } },
    );
  } catch {
    return NextResponse.json(
      { status: "NOT_YET_CONNECTED" },
      {
        status: 503,
        headers: { "Cache-Control": "private, no-store" },
      },
    );
  }
}
