#!/usr/bin/env bash
set -euo pipefail

# Real Supabase Auth JWT -> GoTrue -> PostgREST -> PostgreSQL/RLS integration.
# Runs only against the disposable local stack started by supabase start.
# The service key is used only to create confirmed test users; every tested
# application read/write uses the individual user's short-lived access token.
# Never point this script at a hosted project.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
cd "$ROOT_DIR"
for command in supabase curl jq psql openssl; do
  command -v "$command" >/dev/null 2>&1 || { echo "Required command not found: $command" >&2; exit 1; }
done

status_output="$(supabase status --output env)"
eval "$status_output"
: "${API_URL:?Supabase local API_URL missing}"
: "${DB_URL:?Supabase local DB_URL missing}"
: "${ANON_KEY:?Supabase local ANON_KEY missing}"
: "${SERVICE_ROLE_KEY:?Supabase local SERVICE_ROLE_KEY missing}"

tmp_dir="$(mktemp -d)"
trap 'rm -rf "$tmp_dir"' EXIT
run_suffix="${GITHUB_RUN_ID:-local}-$$"
password="$(openssl rand -hex 24)"
org_a="10000000-0000-4000-8000-000000000001"
workspace_a="20000000-0000-4000-8000-000000000002"
org_b="11000000-0000-4000-8000-000000000011"
workspace_b="22000000-0000-4000-8000-000000000022"
record_a="jwt-tenant-isolation-${run_suffix}"

create_user() {
  local label="$1" email="happy-jwt-$1-${run_suffix}@example.test"
  local body="$tmp_dir/create-$1.json" payload status
  payload="$(jq -cn --arg email "$email" --arg password "$password" '{email:$email,password:$password,email_confirm:true}')"
  status="$(curl -sS -o "$body" -w '%{http_code}' -X POST "$API_URL/auth/v1/admin/users" \
    -H "apikey: $SERVICE_ROLE_KEY" -H "Authorization: Bearer $SERVICE_ROLE_KEY" \
    -H 'Content-Type: application/json' --data "$payload")"
  if [[ ! "$status" =~ ^2 ]]; then echo "Auth user creation failed for $label (HTTP $status)." >&2; cat "$body" >&2; exit 1; fi
  jq -er '.id' "$body"
}

login_user() {
  local label="$1" email="$2" body="$tmp_dir/token-$1.json" payload status
  payload="$(jq -cn --arg email "$email" --arg password "$password" '{email:$email,password:$password}')"
  status="$(curl -sS -o "$body" -w '%{http_code}' -X POST "$API_URL/auth/v1/token?grant_type=password" \
    -H "apikey: $ANON_KEY" -H 'Content-Type: application/json' --data "$payload")"
  if [[ ! "$status" =~ ^2 ]]; then echo "Auth password grant failed for $label (HTTP $status)." >&2; cat "$body" >&2; exit 1; fi
  jq -er '.access_token' "$body"
}

rpc() {
  local label="$1" fn="$2" token="$3" payload="$4" expected="$5"
  local body="$tmp_dir/$1.json" status
  status="$(curl -sS -o "$body" -w '%{http_code}' -X POST "$API_URL/rest/v1/rpc/$fn" \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $token" \
    -H 'Content-Type: application/json' --data "$payload")"
  if [[ "$expected" == "success" ]]; then
    if [[ ! "$status" =~ ^2 ]]; then echo "$label expected success (HTTP $status)." >&2; cat "$body" >&2; exit 1; fi
  elif [[ "$status" =~ ^2 ]] || ! grep -Fq "$expected" "$body"; then
    echo "$label expected denial '$expected' (HTTP $status)." >&2; cat "$body" >&2; exit 1
  fi
  cp "$body" "$tmp_dir/$1-result.json"
}

email_a="happy-jwt-a-${run_suffix}@example.test"
email_b="happy-jwt-b-${run_suffix}@example.test"
email_c="happy-jwt-c-${run_suffix}@example.test"
user_a="$(create_user a)"
user_b="$(create_user b)"
user_c="$(create_user c)"

# Seed only canonical identities as the disposable local DB owner.
psql "$DB_URL" -X -v ON_ERROR_STOP=1 \
  -v user_a="$user_a" -v user_b="$user_b" -v user_c="$user_c" \
  -v org_a="$org_a" -v workspace_a="$workspace_a" -v org_b="$org_b" -v workspace_b="$workspace_b" <<'SQL'
INSERT INTO private.organizations(organization_id,status)
VALUES (:'org_a','ACTIVE'),(:'org_b','ACTIVE');
INSERT INTO private.workspaces(workspace_id,organization_id,status)
VALUES (:'workspace_a',:'org_a','ACTIVE'),(:'workspace_b',:'org_b','ACTIVE');
INSERT INTO private.organization_memberships(organization_id,user_id,status,role)
VALUES (:'org_a',:'user_a','ACTIVE','MEMBER'),(:'org_a',:'user_b','ACTIVE','MEMBER'),
       (:'org_a',:'user_c','ACTIVE','MEMBER'),(:'org_b',:'user_b','ACTIVE','MEMBER');
INSERT INTO private.workspace_memberships(organization_id,workspace_id,user_id,status,role)
VALUES (:'org_a',:'workspace_a',:'user_a','ACTIVE','MEMBER'),
       (:'org_a',:'workspace_a',:'user_b','ACTIVE','MEMBER'),
       (:'org_a',:'workspace_a',:'user_c','ACTIVE','MEMBER'),
       (:'org_b',:'workspace_b',:'user_b','ACTIVE','MEMBER');
SQL

token_a="$(login_user a "$email_a")"
token_b="$(login_user b "$email_b")"
token_c="$(login_user c "$email_c")"

# Assert the password-grant tokens carry the exact Auth user subjects and role.
assert_jwt_subject() {
  local label="$1" token="$2" expected_user="$3"
  local payload subject role
  local encoded
  encoded="$(cut -d. -f2 <<<"$token" | tr '_-' '/+')"
  case $((${#encoded} % 4)) in
    2) encoded+="==" ;;
    3) encoded+="=" ;;
    1) echo "$label JWT payload has invalid base64url length." >&2; exit 1 ;;
  esac
  payload="$(printf '%s' "$encoded" | base64 -d 2>/dev/null)"
  subject="$(jq -er '.sub' <<<"$payload")"
  role="$(jq -er '.role' <<<"$payload")"
  if [[ "$subject" != "$expected_user" || "$role" != "authenticated" ]]; then
    echo "$label JWT subject/role mismatch (sub=$subject role=$role)." >&2
    exit 1
  fi
}
assert_jwt_subject a "$token_a" "$user_a"
assert_jwt_subject b "$token_b" "$user_b"
assert_jwt_subject c "$token_c" "$user_c"

# Temporary local-only diagnostic RPC proves PostgREST exposes auth.uid() as
# the JWT subject for each authenticated request. It is dropped at test end.
psql "$DB_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
CREATE OR REPLACE FUNCTION public.happy_local_jwt_subject_probe()
RETURNS uuid LANGUAGE sql STABLE SET search_path=pg_catalog
AS $probe$ SELECT auth.uid(); $probe$;
GRANT EXECUTE ON FUNCTION public.happy_local_jwt_subject_probe() TO authenticated;
NOTIFY pgrst, 'reload schema';
SQL
# Give PostgREST a bounded window to refresh its schema cache after DDL.
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  if curl --silent --show-error --fail "$API_URL/rest/v1/" \
    --header "apikey: $ANON_KEY" --header "Authorization: Bearer $ANON_KEY" \
    >/dev/null; then
    break
  fi
  sleep 1
done
# PostgREST may accept the schema-reload notification before its cache is
# refreshed. Retry this exact RPC for a bounded period; fail on any non-cache
# error and never treat a missing function as a successful auth probe.
probe_status="000"
for attempt in 1 2 3 4 5 6 7 8 9 10; do
  probe_status="$(curl -sS -o "$tmp_dir/a-auth-subject-result.json" -w '%{http_code}' \
    -X POST "$API_URL/rest/v1/rpc/happy_local_jwt_subject_probe" \
    -H "apikey: $ANON_KEY" -H "Authorization: Bearer $token_a" \
    -H 'Content-Type: application/json' --data '{}')"
  if [[ "$probe_status" =~ ^2 ]]; then break; fi
  if grep -Fq 'PGRST202' "$tmp_dir/a-auth-subject-result.json"; then
    sleep 1
  else
    echo "JWT subject RPC failed with HTTP $probe_status." >&2
    cat "$tmp_dir/a-auth-subject-result.json" >&2
    exit 1
  fi
done
if [[ ! "$probe_status" =~ ^2 ]]; then
  echo "PostgREST did not refresh the local JWT subject RPC schema cache." >&2
  cat "$tmp_dir/a-auth-subject-result.json" >&2
  exit 1
fi
[[ "$(jq -r '.' "$tmp_dir/a-auth-subject-result.json")" == "$user_a" ]] || {
  echo "PostgREST auth.uid() did not match user A's verified JWT subject." >&2
  cat "$tmp_dir/a-auth-subject-result.json" >&2
  exit 1
}

# Revoke C after issuing the JWT; live membership must override a valid token.
psql "$DB_URL" -X -v ON_ERROR_STOP=1 -v user_c="$user_c" -v org_a="$org_a" <<'SQL'
UPDATE private.organization_memberships SET status='REVOKED'
WHERE organization_id=:'org_a' AND user_id=:'user_c';
SQL

scope_a="$(jq -cn --arg org "$org_a" --arg ws "$workspace_a" '{p_organization_id:$org,p_workspace_id:$ws}')"
scope_b="$(jq -cn --arg org "$org_b" --arg ws "$workspace_b" '{p_organization_id:$org,p_workspace_id:$ws}')"
rpc a-active happy_has_active_tenant_scope "$token_a" "$scope_a" success
if ! jq -e 'select(. == true)' "$tmp_dir/a-active-result.json" >/dev/null; then
  echo "User A active-scope probe returned: $(cat "$tmp_dir/a-active-result.json")" >&2
  exit 1
fi
rpc b-active-other-scope happy_has_active_tenant_scope "$token_b" "$scope_b" success
if ! jq -e 'select(. == true)' "$tmp_dir/b-active-other-scope-result.json" >/dev/null; then
  echo "User B active-scope probe returned: $(cat "$tmp_dir/b-active-other-scope-result.json")" >&2
  exit 1
fi
rpc c-revoked-scope happy_has_active_tenant_scope "$token_c" "$scope_a" success
jq -e 'select(. == false)' "$tmp_dir/c-revoked-scope-result.json" >/dev/null

create_a="$(jq -cn --arg org "$org_a" --arg ws "$workspace_a" --arg id "$record_a" \
  '{p_organization_id:$org,p_workspace_id:$ws,p_entity_type:"PROJECT",p_record_id:$id,p_data:{id:$id,owner:"user-a"}}')"
rpc a-create happy_create_tenant_record "$token_a" "$create_a" success
jq -e --arg uid "$user_a" '(.user_id // .[0].user_id) == $uid' "$tmp_dir/a-create-result.json" >/dev/null

records_url="$API_URL/rest/v1/happy_tenant_records?select=user_id,record_id,version&organization_id=eq.$org_a&workspace_id=eq.$workspace_a&record_id=eq.$record_a"
a_rows="$(curl -fsS -H "apikey: $ANON_KEY" -H "Authorization: Bearer $token_a" "$records_url")"
[[ "$(jq 'length' <<<"$a_rows")" == "1" ]] || { echo "Owner JWT could not read its own record." >&2; exit 1; }
b_rows="$(curl -fsS -H "apikey: $ANON_KEY" -H "Authorization: Bearer $token_b" "$records_url")"
[[ "$(jq 'length' <<<"$b_rows")" == "0" ]] || { echo "Same-tenant user read another user's row." >&2; exit 1; }

update_b="$(jq -cn --arg org "$org_a" --arg ws "$workspace_a" --arg id "$record_a" \
  '{p_organization_id:$org,p_workspace_id:$ws,p_entity_type:"PROJECT",p_record_id:$id,p_expected_version:1,p_data:{id:$id,owner:"user-b"}}')"
rpc b-update-a-row-denied happy_update_tenant_record "$token_b" "$update_b" RECORD_NOT_FOUND

cross_create="$(jq -cn --arg org "$org_b" --arg ws "$workspace_b" --arg id "${record_a}-cross" \
  '{p_organization_id:$org,p_workspace_id:$ws,p_entity_type:"PROJECT",p_record_id:$id,p_data:{id:$id}}')"
rpc a-cross-tenant-denied happy_create_tenant_record "$token_a" "$cross_create" TENANT_SCOPE_DENIED

revoked_create="$(jq -cn --arg org "$org_a" --arg ws "$workspace_a" --arg id "${record_a}-revoked" \
  '{p_organization_id:$org,p_workspace_id:$ws,p_entity_type:"PROJECT",p_record_id:$id,p_data:{id:$id}}')"
rpc c-revoked-create-denied happy_create_tenant_record "$token_c" "$revoked_create" TENANT_SCOPE_DENIED

# Direct authenticated INSERT cannot bypass the reviewed create RPC or spoof user_id.
direct_payload="$(jq -cn --arg org "$org_a" --arg ws "$workspace_a" --arg uid "$user_b" --arg id "${record_a}-spoof" \
  '{organization_id:$org,workspace_id:$ws,user_id:$uid,entity_type:"PROJECT",record_id:$id,version:1,data:{id:$id}}')"
direct_status="$(curl -sS -o "$tmp_dir/direct-write.json" -w '%{http_code}' -X POST "$API_URL/rest/v1/happy_tenant_records" \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $token_a" -H 'Content-Type: application/json' --data "$direct_payload")"
if [[ "$direct_status" =~ ^2 ]]; then echo "Direct authenticated INSERT unexpectedly succeeded." >&2; exit 1; fi

# An anon-key-only request must not disclose the authenticated user's row.
anon_status="$(curl -sS -o "$tmp_dir/anon-read.json" -w '%{http_code}' \
  -H "apikey: $ANON_KEY" -H "Authorization: Bearer $ANON_KEY" "$records_url")"
if grep -Fq "$record_a" "$tmp_dir/anon-read.json"; then
  echo "Anonymous request disclosed a tenant record (HTTP $anon_status)." >&2; cat "$tmp_dir/anon-read.json" >&2; exit 1
fi

psql "$DB_URL" -X -v ON_ERROR_STOP=1 <<'SQL'
DROP FUNCTION public.happy_local_jwt_subject_probe();
SQL

echo "PASS: real local Supabase Auth JWTs enforced subject, tenant, workspace, row-owner, and live-membership boundaries."
echo "PASS: cross-tenant create, cross-user read/update, revoked membership, direct INSERT, and anonymous read probes denied."
