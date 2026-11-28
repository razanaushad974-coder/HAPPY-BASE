import { NextResponse, type NextRequest } from "next/server";

import {
  resolveSupabaseRequestTenantContext,
  type RequestScopedSupabaseClient,
} from "@/core/tenant/supabase-request-tenant-composition";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 8 * 1024;
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function response(status: number, payload: Record<string, unknown>) {
  return NextResponse.json(payload, {
    status,
    headers: {
      "Cache-Control": "private, no-store, max-age=0",
      Vary: "Cookie",
      "X-Content-Type-Options": "nosniff",
    },
  });
}

/**
 * Verifies a caller-selected organization/workspace pair against the current
 * Supabase session and the auth.uid()-bound membership RPC. Submitted IDs are
 * selectors only; this route never trusts a caller-supplied user ID and never
 * provisions a tenant or persists a selection.
 */
export async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get("origin");
    if (!origin || origin !== new URL(request.url).origin) {
      return response(403, { status: "ORIGIN_NOT_ALLOWED" });
    }

    if (
      request.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase() !==
      "application/json"
    ) {
      return response(415, { status: "UNSUPPORTED_MEDIA_TYPE" });
    }

    const raw = await request.text();
    if (new TextEncoder().encode(raw).byteLength > MAX_BODY_BYTES) {
      return response(413, { status: "REQUEST_TOO_LARGE" });
    }

    let body: unknown;
    try {
      body = JSON.parse(raw);
    } catch {
      return response(400, { status: "INVALID_JSON" });
    }

    if (typeof body !== "object" || body === null || Array.isArray(body)) {
      return response(400, { status: "INVALID_REQUEST" });
    }

    const record = body as Record<string, unknown>;
    const organizationId =
      typeof record.organizationId === "string" ? record.organizationId.trim() : "";
    const workspaceId =
      typeof record.workspaceId === "string" ? record.workspaceId.trim() : "";

    if (
      !UUID_PATTERN.test(organizationId) ||
      !UUID_PATTERN.test(workspaceId) ||
      Object.keys(record).some((key) => !["organizationId", "workspaceId"].includes(key))
    ) {
      return response(400, { status: "INVALID_TENANT_SELECTION" });
    }

    const supabase = await createClient();
    const tenant = await resolveSupabaseRequestTenantContext(
      {
        async createForCurrentRequest() {
          return supabase as unknown as RequestScopedSupabaseClient;
        },
      },
      { organizationId, workspaceId },
    );

    if (tenant.status === "UNAUTHENTICATED") {
      return response(401, { status: "UNAUTHENTICATED" });
    }
    if (tenant.status !== "AUTHENTICATED") {
      return response(403, { status: "TENANT_ACCESS_DENIED" });
    }

    return response(200, {
      status: "TENANT_CONTEXT_VERIFIED",
      tenant: {
        userId: tenant.context.actor.userId,
        organizationId: tenant.context.organizationId,
        workspaceId: tenant.context.workspaceId,
        organizationRole: tenant.context.organizationRole,
        workspaceRole: tenant.context.workspaceRole,
      },
      authority: "SUPABASE_AUTH_UID_AND_ACTIVE_MEMBERSHIP",
      persisted: false,
    });
  } catch {
    return response(503, { status: "TENANT_CONTEXT_NOT_YET_CONNECTED" });
  }
}
