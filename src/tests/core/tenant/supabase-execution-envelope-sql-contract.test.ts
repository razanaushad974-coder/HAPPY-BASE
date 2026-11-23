import { readFileSync } from "node:fs";
import { resolve } from "node:path";

function assert(condition: boolean, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

const sqlPath = resolve(
  process.cwd(),
  "supabase/drafts/20261121_authenticated_execution_envelope_candidate.sql",
);
const sql = readFileSync(sqlPath, "utf8");
const schedulerPath = resolve(
  process.cwd(),
  "supabase/drafts/20261121_durable_mission_scheduler_candidate.sql",
);
const schedulerSql = readFileSync(schedulerPath, "utf8");
const ownerPath = resolve(
  process.cwd(),
  "supabase/drafts/20261123_tenant_scope_rpc_owner_privilege_candidate.sql",
);
const ownerSql = readFileSync(ownerPath, "utf8");
const createOwnerPath = resolve(
  process.cwd(),
  "supabase/drafts/20261123_execution_request_create_owner_privilege_candidate.sql",
);
const createOwnerSql = readFileSync(createOwnerPath, "utf8");
const decisionOwnerPath = resolve(
  process.cwd(),
  "supabase/drafts/20261123_execution_request_decision_owner_privilege_candidate.sql",
);
const decisionOwnerSql = readFileSync(decisionOwnerPath, "utf8");
const createOwnerRolePath = resolve(
  process.cwd(),
  "supabase/drafts/20261123_execution_request_create_owner_role_candidate.sql",
);
const createOwnerRoleSql = readFileSync(createOwnerRolePath, "utf8");
const decisionOwnerRolePath = resolve(
  process.cwd(),
  "supabase/drafts/20261123_execution_request_decision_owner_role_candidate.sql",
);
const decisionOwnerRoleSql = readFileSync(decisionOwnerRolePath, "utf8");

assert(/add column if not exists input_digest text/i.test(sql), "Payload digest column is missing.");
assert(/add column if not exists envelope_digest text/i.test(sql), "Immutable envelope digest column is missing.");
assert(/extensions\.digest\(convert_to\(p_input::text,'UTF8'\),'sha256'\)/i.test(sql),
  "Database must calculate the payload digest.");
assert(/'requestId',p_request_id[\s\S]*'requesterUserId',v_uid[\s\S]*'executorUserId',v_uid[\s\S]*'organizationId',p_organization_id[\s\S]*'workspaceId',p_workspace_id[\s\S]*'capability',p_capability[\s\S]*'action',p_action[\s\S]*'targetReference',p_target_reference[\s\S]*'idempotencyKey',p_idempotency_key/i.test(sql),
  "Envelope digest must cover immutable request, principal, tenant, capability, action, target, and idempotency fields.");
assert(/'requestId',v_existing\.request_id/i.test(sql),
  "Idempotent retries must recompute the digest using the original persisted request ID.");
assert(/v_existing\.envelope_digest is distinct from v_envelope_digest/i.test(sql),
  "Idempotent retries must compare the persisted envelope digest.");
assert(/row\(new\.request_id[\s\S]*new\.envelope_digest[\s\S]*new\.created_at\)[\s\S]*is distinct from[\s\S]*row\(old\.request_id[\s\S]*old\.envelope_digest[\s\S]*old\.created_at\)/i.test(sql),
  "The database trigger must prevent mutation of immutable envelope fields.");
assert(/create or replace function private\.happy_current_authenticated_user_id\(\)[\s\S]*security definer[\s\S]*set search_path = pg_catalog[\s\S]*select auth\.uid\(\)/i.test(ownerSql),
  "JWT subject accessor must be a minimal SECURITY DEFINER wrapper around auth.uid() with a fixed search_path.");
assert(/alter function private\.happy_current_authenticated_user_id\(\) owner to postgres/i.test(ownerSql) &&
  /revoke all on function private\.happy_current_authenticated_user_id\(\)[\s\S]*from public, anon, authenticated, service_role/i.test(ownerSql) &&
  /grant execute on function private\.happy_current_authenticated_user_id\(\)[\s\S]*to happy_tenant_scope_rpc_owner/i.test(ownerSql),
  "JWT subject accessor must have the reviewed postgres owner and no API-role EXECUTE grants.");
assert(/grant execute on function private\.happy_current_authenticated_user_id\(\)[\s\S]*to happy_execution_request_create_rpc_owner/i.test(createOwnerSql) &&
  /grant execute on function private\.happy_current_authenticated_user_id\(\)[\s\S]*to happy_execution_request_decision_rpc_owner/i.test(decisionOwnerSql),
  "Only the dedicated execution-request function owners may receive the accessor capability.");
assert(/v_uid uuid := private\.happy_current_authenticated_user_id\(\)/i.test(sql) &&
  /v_approver uuid := private\.happy_current_authenticated_user_id\(\)/i.test(sql) &&
  /r\.executor_user_id=private\.happy_current_authenticated_user_id\(\)/i.test(sql),
  "Creation, resolution, and decision RPCs must derive the caller from the private verified JWT-subject accessor.");
assert(/new\.status <> 'WAITING_APPROVAL'[\s\S]*new\.requires_approval is distinct from true[\s\S]*new\.approval_status <> 'PENDING'/i.test(sql),
  "New enveloped requests must start pending founder approval.");
assert(/v_request\.requester_user_id = v_approver/i.test(sql),
  "Founder approval must reject self-approval.");
assert(/v_approver_org_role <> 'FOUNDER'/i.test(sql),
  "Founder approval must verify the active organization FOUNDER role.");
assert(/create table if not exists private\.execution_request_approval_events/i.test(sql) &&
  /before update or delete on private\.execution_request_approval_events/i.test(sql),
  "Approval decision evidence must be append-only.");
assert(/revoke all on function public\.create_authenticated_execution_request[\s\S]*from public,anon,service_role/i.test(sql) &&
  /grant execute on function public\.create_authenticated_execution_request[\s\S]*to authenticated/i.test(sql),
  "Request creation RPC must be authenticated-only, not service-role callable.");
assert(/create role happy_execution_request_create_rpc_owner[\s\S]*nologin noinherit nosuperuser nocreatedb nocreaterole[\s\S]*noreplication nobypassrls/i.test(createOwnerRoleSql) &&
  /create role happy_execution_request_decision_rpc_owner[\s\S]*nologin noinherit nosuperuser nocreatedb nocreaterole[\s\S]*noreplication nobypassrls/i.test(decisionOwnerRoleSql),
  "Execution-request RPC owners must be dedicated NOLOGIN, NOINHERIT, NOBYPASSRLS roles.");
assert(!/create\s+(?:or replace\s+)?function\s+(?:public|private)\.[a-z0-9_]*(?:claim|dispatch|finish|complete)[a-z0-9_]*\s*\(/i.test(sql),
  "This candidate must not introduce a worker claim, dispatch, or completion endpoint.");

const enqueueStart = schedulerSql.indexOf("create or replace function public.happy_enqueue_mission_dispatch(");
const enqueueEnd = schedulerSql.indexOf("$enqueue$;", enqueueStart);
assert(enqueueStart >= 0 && enqueueEnd > enqueueStart, "Durable dispatch enqueue function is missing.");
const enqueueSql = schedulerSql.slice(enqueueStart, enqueueEnd);
assert(/from private\.execution_requests r[\s\S]*r\.request_id = p_execution_request_id[\s\S]*r\.organization_id = p_organization_id[\s\S]*r\.workspace_id = p_workspace_id[\s\S]*r\.task_id = p_task_id[\s\S]*for update/i.test(enqueueSql),
  "Enqueue must lock the exact persisted tenant/request/task envelope.");
assert(/v_request\.status <> 'READY'[\s\S]*v_request\.approval_status <> 'APPROVED'[\s\S]*v_request\.required_approval_role <> 'FOUNDER'/i.test(enqueueSql),
  "Enqueue must require the persisted founder-approved request lifecycle.");
assert(/v_input_digest <> v_request\.input_digest[\s\S]*v_envelope_digest <> v_request\.envelope_digest/i.test(enqueueSql),
  "Enqueue must recompute both persisted input and immutable envelope digests.");
assert(/p_payload is distinct from v_expected_payload[\s\S]*p_idempotency_key is distinct from v_expected_idempotency_key[\s\S]*p_payload_digest is distinct from v_computed_payload_digest/i.test(enqueueSql),
  "Enqueue must compare the full immutable payload, idempotency key and recomputed digest.");
assert(
  enqueueSql.includes("'happy-dispatch:v1:'") &&
    enqueueSql.includes("v_lease.attempt::text") &&
    enqueueSql.includes("v_request.request_id") &&
    enqueueSql.includes("v_request.capability") &&
    enqueueSql.includes("v_request.action"),
  "Dispatch idempotency must be recomputed from the exact tenant, mission, task, attempt and request.",
);
assert(/revoke all on function public\.happy_enqueue_mission_dispatch[\s\S]*from public, anon, authenticated, service_role/i.test(schedulerSql),
  "Worker enqueue remains unavailable until a trusted workload identity is connected.");

console.log("Supabase execution envelope and scheduler SQL static contract: PASS");
