-- HAPPY dedicated worker scheduler RPC EXECUTE grants (DESIGN DRAFT ONLY)
-- Date: 2026-11-23
--
-- Depends on:
--   1. 20261122_worker_principal_registry_candidate.sql
--   2. 20261122_worker_scheduler_rpc_candidate.sql
--   3. 20261123_worker_registry_helper_grant_candidate.sql
--
-- This candidate grants only EXECUTE on the exact worker RPCs required by
-- each active registry capability. It grants no table privileges, no role
-- membership, no CREATE ROLE, no password, and no API/service-role access.
-- Apply only after an operator has separately provisioned and reviewed each
-- dedicated happy_worker_* LOGIN role and registry row.
--
-- CONTROL:
--   claim task, enqueue immutable dispatch, heartbeat, claim outbox,
--   record fenced outcome.
-- VERIFY:
--   append and list reconciliation evidence.
--
-- No hosted database changes have been made by adding this draft.

begin;

do $worker_scheduler_rpc_grants$
declare
  v_login_role text;
  v_capabilities text[];
begin
  for v_login_role, v_capabilities in
    select p.db_login_role, p.capabilities
      from private.happy_worker_principal_registry p
      join pg_catalog.pg_roles r
        on r.rolname = p.db_login_role
     where r.rolcanlogin = true
       and r.rolsuper = false
       and r.rolcreaterole = false
       and r.rolcreatedb = false
       and r.rolreplication = false
       and r.rolbypassrls = false
       and p.enabled = true
       and p.activated_at is not null
       and p.revoked_at is null
  loop
    if v_capabilities @> array['CONTROL']::text[]
       or v_capabilities @> array['VERIFY']::text[] then
      execute format('grant usage on schema private to %I', v_login_role);
    end if;

    if v_capabilities @> array['CONTROL']::text[] then
      execute format(
        'grant execute on function private.happy_require_worker_principal(text) to %I',
        v_login_role
      );
      execute format(
        'grant execute on function private.happy_worker_claim_mission_task(uuid,uuid,uuid,uuid,text,text,text,integer) to %I',
        v_login_role
      );
      execute format(
        'grant execute on function private.happy_worker_enqueue_mission_dispatch(uuid,uuid,uuid,uuid,text,text,uuid,text,bigint,text,text,text,text,text,jsonb) to %I',
        v_login_role
      );
      execute format(
        'grant execute on function private.happy_worker_heartbeat_mission_task_lease(uuid,uuid,uuid,uuid,text,text,uuid,text,bigint,integer) to %I',
        v_login_role
      );
      execute format(
        'grant execute on function private.happy_worker_claim_dispatch_outbox(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint) to %I',
        v_login_role
      );
      execute format(
        'grant execute on function private.happy_worker_claim_next_dispatch_outbox(uuid,uuid,uuid,uuid,text) to %I',
        v_login_role
      );
      execute format(
        'grant execute on function private.happy_worker_record_dispatch_outcome(uuid,uuid,uuid,uuid,uuid,uuid,text,bigint,text,jsonb) to %I',
        v_login_role
      );
    end if;

    if v_capabilities @> array['VERIFY']::text[] then
      execute format(
        'grant execute on function private.happy_worker_append_dispatch_reconciliation_evidence(uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,timestamptz,jsonb) to %I',
        v_login_role
      );
      execute format(
        'grant execute on function private.happy_worker_list_dispatch_reconciliation_evidence(uuid,uuid,uuid,uuid,uuid,text,text,text) to %I',
        v_login_role
      );
    end if;
  end loop;
end;
$worker_scheduler_rpc_grants$;

-- Operator verification after applying in a disposable staging project:
-- 1. CONTROL-only role can execute CONTROL RPCs, but cannot execute VERIFY RPCs.
-- 2. VERIFY-only role can execute VERIFY RPCs, but cannot execute CONTROL RPCs.
-- 3. A role with both capabilities can execute only the eight listed RPCs.
-- 4. No worker role can SELECT/INSERT/UPDATE/DELETE tenant or registry tables.
-- 5. PUBLIC, anon, authenticated, and service_role have no EXECUTE grants.
-- 6. Disabling/revoking the registry row blocks the function body even while
--    PostgreSQL EXECUTE remains granted; role revocation is enforced per call.
--
-- Note: EXECUTE grants are static PostgreSQL ACLs. Registry revocation is
-- enforced inside happy_require_worker_principal()/happy_require_worker_tenant_scope(),
-- not by attempting to mutate role ACLs on every revoke event.

commit;
