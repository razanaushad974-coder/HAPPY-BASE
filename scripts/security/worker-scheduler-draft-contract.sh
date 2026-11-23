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

if ! grep -q "session_user" "$REGISTRY_FILE" || ! grep -q "happy_require_worker_tenant_scope" "$REGISTRY_FILE"; then
  echo "Worker principal registry does not expose the required DB-derived scope boundary." >&2
  exit 1
fi

echo "PASS: eight worker scheduler RPC drafts are tenant-bound, human-JWT independent, SECURITY DEFINER, and have no EXECUTE grants."
