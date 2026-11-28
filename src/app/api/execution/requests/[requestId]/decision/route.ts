import { NextResponse, type NextRequest } from "next/server";

import type {
  SupabaseExecutionRequestDecisionRpcClient,
} from "@/core/tenant/supabase-private-tenant-stores";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function response(status: number, payload: Record<string, unknown>) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

/**
 * Approval authority is checked transactionally by PostgreSQL using auth.uid(),
 * persisted founder membership, exact request scope, and no-self-approval.
 * This endpoint never dispatches the approved request.
 */
export async function POST(
  request: NextRequest,
  context: { params: Promise<{ requestId: string }> },
) {
  try {
    const origin = request.headers.get("origin");
    if (!origin || origin !== new URL(request.url).origin) {
      return response(403, { status: "ORIGIN_NOT_ALLOWED" });
    }
    if (request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !== "application/json") {
      return response(415, { status: "UNSUPPORTED_MEDIA_TYPE" });
    }

    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > 8 * 1024) {
      return response(413, { status: "REQUEST_TOO_LARGE" });
    }
    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return response(400, { status: "INVALID_JSON" });
    }
    if (!isRecord(body) ||
        (body.decision !== "APPROVED" && body.decision !== "REJECTED") ||
        typeof body.reason !== "string" ||
        !body.reason.trim() || body.reason.length > 1000) {
      return response(400, { status: "INVALID_DECISION" });
    }

    const { requestId } = await context.params;
    if (!requestId || requestId.length > 160) {
      return response(400, { status: "INVALID_REQUEST_ID" });
    }

    const supabase = await createClient();
    const { data, error: authError } = await supabase.auth.getUser();
    if (authError || !data.user?.id) {
      return response(401, { status: "UNAUTHENTICATED" });
    }

    const rpc = supabase as unknown as SupabaseExecutionRequestDecisionRpcClient;
    const result = await rpc.rpc("decide_authenticated_execution_request", {
      p_request_id: requestId,
      p_decision: body.decision,
      p_reason: body.reason.trim(),
    });

    if (result.error) {
      return response(503, { status: "NOT_YET_CONNECTED", reason: "APPROVAL_DECISION_STORE_UNAVAILABLE" });
    }
    if (result.data !== true) {
      return response(403, { status: "APPROVAL_DENIED_OR_REQUEST_NOT_PENDING" });
    }

    return response(200, {
      status: body.decision,
      requestId,
      executionStatus: body.decision === "APPROVED" ? "READY" : "CANCELLED",
      dispatch: "NOT_DISPATCHED",
    });
  } catch {
    return response(503, { status: "NOT_YET_CONNECTED" });
  }
}
