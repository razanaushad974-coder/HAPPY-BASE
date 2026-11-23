#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRAFTS="$ROOT_DIR/supabase/drafts"
MANIFEST="$ROOT_DIR/docs/security/supabase-migration-dependency-owner-manifest-2026-11-23.md"
READINESS="$ROOT_DIR/docs/security/supabase-staging-migration-readiness-2026-11-23.md"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

test -d "$DRAFTS" || fail "supabase/drafts is missing"
test -s "$MANIFEST" || fail "dependency/owner manifest is missing"
test -s "$READINESS" || fail "staging readiness review is missing"

# This audit is intentionally a draft preflight, not a migration deployer.
# It must never create config, migrations, roles, grants, or database objects.
required=(
  20261119_file_mutation_atomic_consume_candidate.sql
  20261123_canonical_tenant_identity_schema_candidate.sql
  20261119_async_tenant_persistence_schema_candidate.sql
  20261123_execution_request_base_schema_candidate.sql
  20261121_authenticated_execution_envelope_candidate.sql
  20261121_durable_mission_scheduler_candidate.sql
  20261122_worker_principal_registry_candidate.sql
  20261122_worker_scheduler_rpc_candidate.sql
  20261123_tenant_scope_rpc_owner_role_candidate.sql
  20261123_tenant_scope_rpc_owner_privilege_candidate.sql
  20261123_execution_request_create_owner_role_candidate.sql
  20261123_execution_request_create_owner_privilege_candidate.sql
  20261123_execution_request_decision_owner_role_candidate.sql
  20261123_execution_request_decision_owner_privilege_candidate.sql
  20261123_worker_registry_owner_role_candidate.sql
  20261123_worker_registry_owner_privilege_candidate.sql
  20261123_worker_scheduler_rpc_owner_role_candidate.sql
  20261123_worker_scheduler_rpc_owner_privilege_candidate.sql
  20261123_worker_registry_helper_grant_candidate.sql
  20261123_worker_scheduler_rpc_grant_candidate.sql
)
for file in "${required[@]}"; do
  test -s "$DRAFTS/$file" || fail "required draft missing: $file"
done
pass "required draft inventory is present"

# The replacement identity/request baselines must stay isolated from the
# blocked legacy file-mutation candidate and withhold runtime table grants.
IDENTITY_BASELINE="$DRAFTS/20261123_canonical_tenant_identity_schema_candidate.sql"
REQUEST_BASELINE="$DRAFTS/20261123_execution_request_base_schema_candidate.sql"
if grep -Eiq '^[[:space:]]*grant[[:space:]].*service_role' "$IDENTITY_BASELINE" "$REQUEST_BASELINE"; then
  fail "identity/request baseline grants table or schema authority to service_role"
fi
for table in organizations workspaces organization_memberships workspace_memberships; do
  grep -Eiq "alter table private\.$table enable row level security" "$IDENTITY_BASELINE" \
    || fail "identity baseline does not enable RLS on $table"
done
grep -Eiq 'alter table private\.execution_requests enable row level security' "$REQUEST_BASELINE" \
  || fail "execution request base does not enable RLS"
pass "isolated identity/request baselines enable RLS and contain no service_role grants"

# Every function-owner role candidate must create a NOLOGIN, NOINHERIT,
# NOBYPASSRLS role and must not enable any elevated role attribute.
owners=(
  happy_tenant_scope_rpc_owner
  happy_execution_request_create_rpc_owner
  happy_execution_request_decision_rpc_owner
  happy_worker_registry_owner
  happy_worker_scheduler_rpc_owner
)
role_files=(
  20261123_tenant_scope_rpc_owner_role_candidate.sql
  20261123_execution_request_create_owner_role_candidate.sql
  20261123_execution_request_decision_owner_role_candidate.sql
  20261123_worker_registry_owner_role_candidate.sql
  20261123_worker_scheduler_rpc_owner_role_candidate.sql
)
for i in "${!owners[@]}"; do
  file="$DRAFTS/${role_files[$i]}"
  role="${owners[$i]}"
  block="$(awk -v role="$role" '
    index($0, "CREATE ROLE " role) || index($0, "create role " role) { inside=1 }
    inside { print }
    inside && /;/ { exit }
  ' "$file")"
  test -n "$block" || fail "CREATE ROLE statement missing for $role"
  grep -Eiq 'NOLOGIN' <<<"$block" || fail "$role is not NOLOGIN"
  grep -Eiq 'NOINHERIT' <<<"$block" || fail "$role is not NOINHERIT"
  grep -Eiq 'NOBYPASSRLS' <<<"$block" || fail "$role is not NOBYPASSRLS"
  grep -Eiq 'NOSUPERUSER' <<<"$block" || fail "$role is not NOSUPERUSER"
  grep -Eiq 'NOCREATEROLE' <<<"$block" || fail "$role is not NOCREATEROLE"
  grep -Eiq 'NOCREATEDB' <<<"$block" || fail "$role is not NOCREATEDB"
  grep -Eiq 'NOREPLICATION' <<<"$block" || fail "$role is not NOREPLICATION"
  if grep -Eiq '(^|[[:space:]])(LOGIN|INHERIT|BYPASSRLS|SUPERUSER|CREATEROLE|CREATEDB|REPLICATION)([[:space:];]|$)' <<<"$block"; then
    fail "$role CREATE ROLE block contains an elevated/contradictory attribute"
  fi
done
pass "five function-owner role definitions enforce NOLOGIN/NOINHERIT/NOBYPASSRLS and non-elevated attributes"

# Superseded files must remain inert; stale dependency notes must not be
# executable inputs to a future migration chain.
for file in \
  20261121_authenticated_execution_request_rpc_candidate.sql \
  20261121_authenticated_tenant_context_rpc_candidate.sql; do
  path="$DRAFTS/$file"
  grep -Eiq 'SUPERSEDED DESIGN NOTE' "$path" || fail "$file is not marked superseded"
  if grep -Eiq '^[[:space:]]*(create|alter|grant|revoke)[[:space:]]' "$path"; then
    fail "$file contains executable DDL/DCL despite being superseded"
  fi
done
pass "superseded SQL notes are non-executable"

# Worker scheduler definitions must withhold EXECUTE; grants remain separate.
WORKER_SQL="$DRAFTS/20261122_worker_scheduler_rpc_candidate.sql"
WORKER_GRANTS="$DRAFTS/20261123_worker_scheduler_rpc_grant_candidate.sql"
if grep -Eiq '^[[:space:]]*grant[[:space:]]+execute[[:space:]]+on[[:space:]]+function[[:space:]]+private\.happy_worker_' "$WORKER_SQL"; then
  fail "worker RPC base draft contains EXECUTE grants"
fi
for fn in \
  happy_worker_claim_mission_task \
  happy_worker_enqueue_mission_dispatch \
  happy_worker_heartbeat_mission_task_lease \
  happy_worker_claim_dispatch_outbox \
  happy_worker_claim_next_dispatch_outbox \
  happy_worker_record_dispatch_outcome; do
  grep -Eiq "grant[[:space:]]+execute[[:space:]]+on[[:space:]]+function[[:space:]]+private\.$fn\(" "$WORKER_GRANTS" || fail "CONTROL grant candidate missing $fn"
done
for fn in happy_worker_append_dispatch_reconciliation_evidence happy_worker_list_dispatch_reconciliation_evidence; do
  grep -Eiq "grant[[:space:]]+execute[[:space:]]+on[[:space:]]+function[[:space:]]+private\.$fn\(" "$WORKER_GRANTS" || fail "VERIFY grant candidate missing $fn"
done
if grep -Eiq 'grant[[:space:]]+execute[[:space:]]+on[[:space:]]+function[[:space:]]+private\.happy_worker_[^(]+\([^;]+[[:space:]]to[[:space:]]+(public|anon|authenticated|service_role)' "$WORKER_GRANTS"; then
  fail "worker RPC grants target PUBLIC or an API role"
fi
pass "worker EXECUTE grants remain separate and capability-scoped"

# Reuse the existing exact worker signature / tenant-boundary contract.
bash "$ROOT_DIR/scripts/security/worker-scheduler-draft-contract.sh"
pass "existing worker scheduler draft contract"

# Migration bootstrap is a deliberate hard gate, not an auto-created artifact.
if [[ ! -f "$ROOT_DIR/supabase/config.toml" || ! -d "$ROOT_DIR/supabase/migrations" ]]; then
  echo "BLOCKED: no Supabase CLI config/migration chain exists; do not apply drafts."
else
  echo "INFO: Supabase config and migration directory exist; ordered migration review is still required."
fi

echo "PASS: static staging draft preflight complete; this script does not apply SQL or certify staging readiness."
