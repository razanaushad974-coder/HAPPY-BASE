import { NextResponse, type NextRequest } from "next/server";

import {
  resolveSupabaseRequestTenantContext,
  type RequestScopedSupabaseClient,
} from "@/core/tenant/supabase-request-tenant-composition";
import type {
  SupabaseExecutionRequestCreateRpcClient,
} from "@/core/tenant/supabase-private-tenant-stores";
import { createClient } from "@/lib/supabase/server";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

const MAX_BODY_BYTES = 64 * 1024;
const CAPABILITIES = [
  "CODE", "FILE", "API", "BROWSER", "SHELL", "DATABASE",
  "AI", "DEPLOYMENT", "PUBLISH", "AUTOMATION",
] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function requiredText(value: unknown, maxLength: number): string | null {
  return typeof value === "string" && value.trim().length > 0 && value.length <= maxLength
    ? value.trim()
    : null;
}

function jsonObject(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}

function validTargetReference(value: Record<string, unknown> | null): boolean {
  if (value === null) return true;
  return typeof value.token === "string" && value.token.length > 0 &&
    ["PROJECT", "MISSION", "TASK", "FILE", "DATABASE"].includes(String(value.entityType)) &&
    typeof value.entityId === "string" && value.entityId.length > 0 &&
    ["HIGH", "MEDIUM", "LOW", "UNKNOWN"].includes(String(value.confidence)) &&
    ["ACTIVE_CONTEXT", "PERSISTED_MEMORY"].includes(String(value.source));
}

function response(status: number, payload: Record<string, unknown>) {
  return NextResponse.json(payload, {
    status,
    headers: { "Cache-Control": "private, no-store" },
  });
}

/**
 * Persists an authenticated execution intent only.
 * Every request is forced to HIGH risk / FOUNDER approval by the database RPC.
 * This route never dispatches work or marks a request approved.
 */
export async function POST(request: NextRequest) {
  try {
    const origin = request.headers.get("origin");
    if (!origin || origin !== new URL(request.url).origin) {
      return response(403, { status: "ORIGIN_NOT_ALLOWED" });
    }

    if (!request.headers.get("content-type")?.toLowerCase().includes("application/json")) {
      return response(415, { status: "UNSUPPORTED_MEDIA_TYPE" });
    }

    const idempotencyKey = requiredText(request.headers.get("idempotency-key"), 160);
    if (!idempotencyKey || !/^[A-Za-z0-9._:-]{8,160}$/.test(idempotencyKey)) {
      return response(400, { status: "IDEMPOTENCY_KEY_REQUIRED" });
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
    if (!isRecord(body)) return response(400, { status: "INVALID_REQUEST" });

    const organizationId = requiredText(body.organizationId, 80);
    const workspaceId = requiredText(body.workspaceId, 80);
    const taskId = requiredText(body.taskId, 160);
    const missionId = requiredText(body.missionId, 160);
    const action = requiredText(body.action, 240);
    const capability = requiredText(body.capability, 32);
    const input = jsonObject(body.input);
    const targetReference = body.targetReference === undefined || body.targetReference === null
      ? null
      : jsonObject(body.targetReference);

    const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
    if (!organizationId || !workspaceId || !uuidPattern.test(organizationId) || !uuidPattern.test(workspaceId) ||
        !taskId || !missionId || !action ||
        !capability || !CAPABILITIES.includes(capability as typeof CAPABILITIES[number]) ||
        !input || !validTargetReference(targetReference)) {
      return response(400, { status: "INVALID_REQUEST_ENVELOPE" });
    }

    const supabase = await createClient();
    const tenant = await resolveSupabaseRequestTenantContext({
      async createForCurrentRequest() {
        return supabase as unknown as RequestScopedSupabaseClient;
      },
    }, { organizationId, workspaceId });

    if (tenant.status === "UNAUTHENTICATED") {
      return response(401, { status: "UNAUTHENTICATED" });
    }
    if (tenant.status !== "AUTHENTICATED") {
      return response(403, { status: "TENANT_ACCESS_DENIED" });
    }

    const rpc = supabase as unknown as SupabaseExecutionRequestCreateRpcClient;
    const result = await rpc.rpc("create_authenticated_execution_request", {
      p_request_id: crypto.randomUUID(),
      p_task_id: taskId,
      p_mission_id: missionId,
      p_organization_id: organizationId,
      p_workspace_id: workspaceId,
      p_capability: capability as typeof CAPABILITIES[number],
      p_action: action,
      p_input: input,
      p_target_reference: targetReference,
      p_idempotency_key: idempotencyKey,
    });

    if (result.error) {
      return response(503, { status: "NOT_YET_CONNECTED", reason: "DURABLE_EXECUTION_REQUEST_STORE_UNAVAILABLE" });
    }

    const rows = Array.isArray(result.data)
      ? result.data
      : result.data === null || result.data === undefined ? [] : [result.data];
    if (rows.length !== 1 || !isRecord(rows[0])) {
      return response(503, { status: "PERSISTENCE_UNVERIFIED" });
    }

    const persisted = rows[0];
    if (persisted.requester_user_id !== tenant.context.actor.userId ||
        persisted.executor_user_id !== tenant.context.actor.userId ||
        persisted.organization_id !== organizationId ||
        persisted.workspace_id !== workspaceId ||
        persisted.task_id !== taskId ||
        persisted.mission_id !== missionId ||
        persisted.capability !== capability ||
        persisted.action !== action ||
        persisted.requires_approval !== true ||
        persisted.risk !== "HIGH" ||
        persisted.approval_status !== "PENDING" ||
        persisted.required_approval_role !== "FOUNDER" ||
        persisted.status !== "WAITING_APPROVAL" ||
        typeof persisted.request_id !== "string" ||
        typeof persisted.input_digest !== "string" ||
        !/^[0-9a-f]{64}$/.test(persisted.input_digest)) {
      return response(503, { status: "PERSISTENCE_UNVERIFIED" });
    }

    return response(202, {
      status: "WAITING_APPROVAL",
      requestId: persisted.request_id,
      risk: "HIGH",
      requiredApprovalRole: "FOUNDER",
      dispatch: "NOT_DISPATCHED",
    });
  } catch {
    return response(503, { status: "NOT_YET_CONNECTED" });
  }
}
