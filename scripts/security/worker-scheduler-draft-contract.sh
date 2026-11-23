#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
SQL_FILE="$ROOT_DIR/supabase/drafts/20261122_worker_scheduler_rpc_candidate.sql"
REGISTRY_FILE="$ROOT_DIR/supabase/drafts/20261122_worker_principal_registry_candidate.sql"

test -s "$SQL_FILE"
test -s "$REGISTRY_FILE"

functions=(
  happy_worker_claim_mission_task
  happy_worker_enqueue_mission_dispatch
  happy_worker_heartbeat_mission_task_lease
  happy_worker_claim_dispatch_outbox
  happy_worker_claim_next_dispatch_outbox
  happy_worker_record_dispatch_outcome
  happy_worker_append_dispatch_reconciliation_evidence
  happy_worker_list_dispatch_reconciliation_evidence
)

tmp="$(mktemp)"
trap 'rm -f "$tmp"' EXIT

for function_name in "${functions[@]}"; do
  if ! awk -v fn="$function_name" '
    index($0, "create or replace function private." fn "(") > 0 { inside=1 }
    inside { print }
    inside && /^\$[a-z_]+\$;$/ { found_end=1; exit }
    END { if (!found_end) exit 2 }
  ' "$SQL_FILE" > "$tmp"; then
    echo "Missing or unterminated worker RPC definition: $function_name" >&2
    exit 1
  fi
  if ! grep -q "happy_require_worker_tenant_scope" "$tmp"; then
    echo "Worker RPC does not derive tenant scope: $function_name" >&2
    exit 1
  fi
  if grep -q "auth\.uid()" "$tmp"; then
    echo "Worker RPC must not use human JWT identity: $function_name" >&2
    exit 1
  fi
  if ! grep -q "security definer" "$tmp"; then
    echo "Worker RPC security mode missing: $function_name" >&2
    exit 1
  fi
done

if ! awk -v fn="happy_worker_claim_mission_task" '
  index($0, "create or replace function private." fn "(") > 0 { inside=1 }
  inside { print }
  inside && index($0, "$claim$;") > 0 { exit }
' "$SQL_FILE" | grep -q "r.approval_status = 'APPROVED'"; then
  echo "Task claim must return only a persisted founder-approved execution request." >&2
  exit 1
fi

if ! awk -v fn="happy_worker_claim_next_dispatch_outbox" '
  index($0, "create or replace function private." fn "(") > 0 { inside=1 }
  inside { print }
  inside && /^\$[a-z_]+\$;$/ { exit }
' "$SQL_FILE" | grep -q "v_request.approval_status <> 'APPROVED'"; then
  echo "Next-dispatch claim must revalidate persisted founder approval." >&2
  exit 1
fi

if ! awk -v fn="happy_worker_claim_mission_task" '
  index($0, "create or replace function private." fn "(") > 0 { inside=1 }
  inside { print }
  inside && index($0, "$claim$;") > 0 { exit }
' "$SQL_FILE" | grep -q "not in ('PENDING','READY','RUNNING')"; then
  echo "Worker task claim must accept PENDING tasks whose dependencies are checked transactionally." >&2
  exit 1
fi

if grep -Eq 'grant execute on function private\.happy_worker_' "$SQL_FILE"; then
  echo "Worker RPC EXECUTE grants must remain withheld until live identity verification." >&2
  exit 1
fi

if [[ "$(grep -c '^revoke all on function private\.happy_worker_' "$SQL_FILE")" -ne "${#functions[@]}" ]]; then
  echo "Expected exact revokes for all eight worker RPCs." >&2
  exit 1
fi

if ! awk -v fn="happy_worker_record_dispatch_outcome" '
  index($0, "create or replace function private." fn "(") > 0 { inside=1 }
  inside { print }
  inside && index($0, "$outcome$;") > 0 { exit }
' "$SQL_FILE" | grep -q "when p_status = 'ACKNOWLEDGED' then 'VERIFYING'"; then
  echo "Dispatch acknowledgement must move the task to VERIFYING, not COMPLETED." >&2
  exit 1
fi

if ! awk -v fn="happy_worker_record_dispatch_outcome" '
  index($0, "create or replace function private." fn "(") > 0 { inside=1 }
  inside { print }
  inside && index($0, "$outcome$;") > 0 { exit }
' "$SQL_FILE" | grep -q "MISSION_VERSION_CONFLICT"; then
  echo "Dispatch outcome must persist the aggregate mission snapshot with version fencing." >&2
  exit 1
fi

if ! grep -q "session_user" "$REGISTRY_FILE" || ! grep -q "happy_require_worker_tenant_scope" "$REGISTRY_FILE"; then
  echo "Worker principal registry does not expose the required DB-derived scope boundary." >&2
  exit 1
fi


GRANT_FILE="$ROOT_DIR/supabase/drafts/20261123_worker_scheduler_rpc_grant_candidate.sql"
test -s "$GRANT_FILE"

# EXECUTE grants live in a separate operator-reviewed candidate. Verify exact
# CONTROL/VERIFY separation and reject broad/public API grants.
for rpc in \
  happy_worker_claim_mission_task \
  happy_worker_enqueue_mission_dispatch \
  happy_worker_heartbeat_mission_task_lease \
  happy_worker_claim_dispatch_outbox \
  happy_worker_claim_next_dispatch_outbox \
  happy_worker_record_dispatch_outcome; do
  if ! grep -q "grant execute on function private.$rpc" "$GRANT_FILE"; then
    echo "Missing capability-scoped CONTROL grant: $rpc" >&2
    exit 1
  fi
done

for rpc in \
  happy_worker_append_dispatch_reconciliation_evidence \
  happy_worker_list_dispatch_reconciliation_evidence; do
  if ! grep -q "grant execute on function private.$rpc" "$GRANT_FILE"; then
    echo "Missing capability-scoped VERIFY grant: $rpc" >&2
    exit 1
  fi
done

if grep -Eiq 'grant execute on function private\.happy_worker_.* to (public|anon|authenticated|service_role)' "$GRANT_FILE"; then
  echo "Worker scheduler grants must never target PUBLIC or API roles." >&2
  exit 1
fi

if grep -Eiq 'grant (select|insert|update|delete|all) on (all )?tables' "$GRANT_FILE"; then
  echo "Worker scheduler grant candidate must not grant table access." >&2
  exit 1
fi

echo "PASS: eight worker scheduler RPC drafts are tenant-bound, human-JWT independent, SECURITY DEFINER, and have only a separate capability-scoped grant candidate."

# Bind the grant candidate to the exact SQL function signatures. Name-only
# checks can pass while PostgreSQL rejects a grant due to an overload mismatch.
normalized_sql="$(tr -d '[:space:]' < "$SQL_FILE")"
normalized_grants="$(tr -d '[:space:]' < "$GRANT_FILE")"

rpc_names=(
  happy_worker_claim_mission_task
  happy_worker_enqueue_mission_dispatch
  happy_worker_heartbeat_mission_task_lease
  happy_worker_claim_dispatch_outbox
  happy_worker_claim_next_dispatch_outbox
  happy_worker_record_dispatch_outcome
  happy_worker_append_dispatch_reconciliation_evidence
  happy_worker_list_dispatch_reconciliation_evidence
)
rpc_signatures=(
  'uuid,uuid,uuid,uuid,text,text,text,integer'
  'uuid,uuid,uuid,uuid,text,text,uuid,text,bigint,text,text,text,text,text,jsonb'
  'uuid,uuid,uuid,uuid,text,text,uuid,text,bigint,integer'
  'uuid,uuid,uuid,uuid,uuid,uuid,text,bigint'
  'uuid,uuid,uuid,uuid,text'
  'uuid,uuid,uuid,uuid,uuid,uuid,text,bigint,text,jsonb'
  'uuid,uuid,uuid,uuid,uuid,uuid,text,text,text,timestamptz,jsonb'
  'uuid,uuid,uuid,uuid,uuid,text,text,text'
)

for i in "${!rpc_names[@]}"; do
  rpc="${rpc_names[$i]}"
  signature="${rpc_signatures[$i]}"
  # SQL declarations include parameter names while GRANT signatures do not.
  # Extract only the declared argument types before comparing PostgreSQL overloads.
  declared_signature="$(perl -0777 -e '
    my ($fn, $file) = @ARGV;
    local $/;
    open my $fh, "<", $file or die $!;
    my $sql = <$fh>;
    if ($sql !~ /create\\s+or\\s+replace\\s+function\\s+private\\.\\Q$fn\\E\\s*\\((.*?)\\)/is) {
      exit 2;
    }
    my @args = split /,/, $1;
    for (@args) {
      s/^\\s*p_[a-z0-9_]+\\s+//i;
      s/\\s+/ /g;
      s/^\\s+|\\s+$//g;
      $_ = lc $_;
    }
    print join(",", @args);
  ' "$rpc" "$SQL_FILE")" || {
    echo "Unable to extract SQL function signature: $rpc" >&2
    exit 1
  }
  if [[ "$declared_signature" != "$signature" ]]; then
    echo "SQL function signature mismatch for $rpc: expected ($signature), found ($declared_signature)" >&2
    exit 1
  fi
  grant="grantexecuteonfunctionprivate.$rpc($signature)"
  if [[ "$normalized_grants" != *"$grant"* ]]; then
    echo "EXECUTE grant signature does not match SQL function: $rpc($signature)" >&2
    exit 1
  fi
done

echo "PASS: all eight capability-scoped EXECUTE grants match exact SQL function overload signatures."
