#!/usr/bin/env bash
set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
DRAFTS="$ROOT_DIR/supabase/drafts"
ENVELOPE="$DRAFTS/20261121_authenticated_execution_envelope_candidate.sql"
ROLE="$DRAFTS/20261123_execution_request_decision_owner_role_candidate.sql"
PRIVILEGES="$DRAFTS/20261123_execution_request_decision_owner_privilege_candidate.sql"

fail() { echo "FAIL: $*" >&2; exit 1; }
pass() { echo "PASS: $*"; }

for file in "$ENVELOPE" "$ROLE" "$PRIVILEGES"; do
  test -s "$file" || fail "required founder-decision candidate missing: $file"
done

# Bind the exact public decision RPC and internal scope helper to the
# dedicated non-login owner. A name-only assertion would miss overload drift.
grep -Eiq 'create[[:space:]]+function[[:space:]]+public\.decide_authenticated_execution_request[[:space:]]*\([[:space:]]*p_request_id[[:space:]]+text[[:space:]]*,[[:space:]]*p_decision[[:space:]]+text[[:space:]]*,[[:space:]]*p_reason[[:space:]]+text' "$ENVELOPE" \
  || fail "public founder decision RPC definition/signature is missing"
grep -Eiq 'alter[[:space:]]+function[[:space:]]+public\.decide_authenticated_execution_request\(text,text,text\)[[:space:]]+owner[[:space:]]+to[[:space:]]+happy_execution_request_decision_rpc_owner' "$PRIVILEGES" \
  || fail "exact public decision RPC overload is not transferred to the decision owner"
grep -Eiq 'create[[:space:]]+or[[:space:]]+replace[[:space:]]+function[[:space:]]+private\.happy_is_active_founder_approval_scope[[:space:]]*\([[:space:]]*p_organization_id[[:space:]]+uuid[[:space:]]*,[[:space:]]*p_workspace_id[[:space:]]+uuid' "$PRIVILEGES" \
  || fail "internal founder-scope helper definition/signature is missing"
grep -Eiq 'alter[[:space:]]+function[[:space:]]+private\.happy_is_active_founder_approval_scope\(uuid,uuid\)[[:space:]]+owner[[:space:]]+to[[:space:]]+happy_execution_request_decision_rpc_owner' "$PRIVILEGES" \
  || fail "exact founder-scope helper overload is not transferred to the decision owner"

# Both SECURITY DEFINER entry points must pin search_path to pg_catalog.
grep -Eiq 'language[[:space:]]+sql[[:space:]]+stable[[:space:]]+security[[:space:]]+definer[[:space:]]+set[[:space:]]+search_path[[:space:]]*=[[:space:]]*pg_catalog' "$PRIVILEGES" \
  || fail "founder-scope helper is not SECURITY DEFINER with fixed pg_catalog search_path"
awk '
  /create[[:space:]]+function[[:space:]]+public\.decide_authenticated_execution_request/ { inside=1 }
  inside { print }
  inside && /\$function\$;/ { exit }
' "$ENVELOPE" | grep -Eiq 'security[[:space:]]+definer[[:space:]]+set[[:space:]]+search_path[[:space:]]*=[[:space:]]*pg_catalog' \
  || fail "decision RPC is not SECURITY DEFINER with fixed pg_catalog search_path"

# Founder authorization is based on the current authenticated subject and
# active founder memberships, never caller-supplied actor identity.
for token in \
  "private.happy_current_authenticated_user_id()" \
  "om.role='FOUNDER'" \
  "om.status='ACTIVE'" \
  "wm.status='ACTIVE'" \
  "o.status='ACTIVE'" \
  "w.status='ACTIVE'"; do
  grep -Fq "$token" "$PRIVILEGES" || fail "founder scope helper missing authorization predicate: $token"
done

# The identity-row UPDATE grants are lock anchors only. The decision owner
# must not be able to mutate identity rows while it locks/revalidates them.
for table in organizations workspaces organization_memberships workspace_memberships; do
  grep -Eiq "grant[[:space:]]+update[[:space:]]*\(status\)[[:space:]]+on[[:space:]]+private\.$table[[:space:]]+to[[:space:]]+happy_execution_request_decision_rpc_owner" "$PRIVILEGES" \
    || fail "decision owner is missing the narrow lock-anchor UPDATE(status) grant on $table"
done
grep -Fq "FOR UPDATE TO %I USING (true) WITH CHECK (false)" "$PRIVILEGES" \
  || fail "decision owner lock-only UPDATE policy is missing"

# Only authenticated receives the public decision RPC. Internal helper and
# all broad/default entry points remain revoked.
grep -Eiq 'revoke[[:space:]]+all[[:space:]]+on[[:space:]]+function[[:space:]]+public\.decide_authenticated_execution_request\(text,text,text\)[[:space:]]+from[[:space:]]+public,anon,service_role' "$PRIVILEGES" \
  || fail "decision RPC does not revoke PUBLIC/anon/service_role"
grep -Eiq 'grant[[:space:]]+execute[[:space:]]+on[[:space:]]+function[[:space:]]+public\.decide_authenticated_execution_request\(text,text,text\)[[:space:]]+to[[:space:]]+authenticated' "$PRIVILEGES" \
  || fail "decision RPC is not explicitly granted only to authenticated"
grep -Eiq 'revoke[[:space:]]+all[[:space:]]+on[[:space:]]+function[[:space:]]+private\.happy_is_active_founder_approval_scope\(uuid,uuid\)[[:space:]]+from[[:space:]]+public,anon,authenticated,service_role' "$PRIVILEGES" \
  || fail "internal founder-scope helper remains callable by API roles"

# The owner role must be NOLOGIN/NOBYPASSRLS and its only membership grant
# must be the trusted migration executor used for ALTER FUNCTION OWNER.
grep -Eiq 'create[[:space:]]+role[[:space:]]+happy_execution_request_decision_rpc_owner[[:space:]]+nologin[[:space:]]+noinherit[[:space:]]+nosuperuser' "$ROLE" \
  || fail "decision owner role is not provisioned with restrictive attributes"
grep -Eiq 'nobypassrls' "$ROLE" || fail "decision owner role must not bypass RLS"
if grep -Eiq 'grant[[:space:]]+happy_execution_request_decision_rpc_owner[[:space:]]+to[[:space:]]+(anon|authenticated|service_role|authenticator|happy_worker_[a-z0-9_]*)' "$ROLE"; then
  fail "decision owner is granted to an API or worker principal"
fi
grep -Eiq 'grant[[:space:]]+happy_execution_request_decision_rpc_owner[[:space:]]+to[[:space:]]+postgres' "$ROLE" \
  || fail "decision owner lacks the explicitly documented migration-executor ownership-transfer membership"

pass "founder decision RPC: exact overload ownership, fixed search_path, current-subject founder scope, lock-only identity grants, and restricted EXECUTE surface"
