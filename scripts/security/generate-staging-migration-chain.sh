#!/usr/bin/env bash
set -euo pipefail

repo_root="$(git rev-parse --show-toplevel)"
cd "$repo_root"

if [[ -e supabase/config.toml || -d supabase/migrations ]]; then
  existing_count="$(find supabase/migrations -maxdepth 1 -type f -name '*.sql' 2>/dev/null | wc -l | tr -d ' ')"
  if [[ -f supabase/config.toml && "$existing_count" == "18" \
        && -f docs/security/supabase-staging-migration-chain.md \
        && -f docs/security/supabase-staging-migration-checksums.sha256 ]]; then
    echo "Complete committed migration chain detected; preserve timestamps and replay it as-is."
    exit 0
  fi
  echo "Refusing to overwrite an incomplete Supabase CLI bootstrap or migration chain." >&2
  exit 2
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
source_root="$repo_root/supabase/drafts"

# Each entry is: migration_name|reviewed_source_draft.
# The order is dependency-driven; superseded notes and withheld worker grants
# are intentionally excluded.
entries=(
  "0001_canonical_tenant_identity|20261123_canonical_tenant_identity_schema_candidate.sql"
  "0002_tenant_scope_owner_role|20261123_tenant_scope_rpc_owner_role_candidate.sql"
  "0003_worker_registry_owner_role|20261123_worker_registry_owner_role_candidate.sql"
  "0004_execution_request_create_owner_role|20261123_execution_request_create_owner_role_candidate.sql"
  "0005_execution_request_decision_owner_role|20261123_execution_request_decision_owner_role_candidate.sql"
  "0006_worker_scheduler_owner_role|20261123_worker_scheduler_rpc_owner_role_candidate.sql"
  "0007_tenant_scope_authenticated_user_accessor|20261124_authenticated_user_id_accessor_bootstrap_candidate.sql"
  "0008_async_tenant_persistence|20261119_async_tenant_persistence_schema_candidate.sql"
  "0009_tenant_scope_owner_privileges|20261123_tenant_scope_rpc_owner_privilege_candidate.sql"
  "0010_execution_request_base|20261123_execution_request_base_schema_candidate.sql"
  "0011_authenticated_execution_envelope|20261121_authenticated_execution_envelope_candidate.sql"
  "0012_execution_request_create_owner_privileges|20261123_execution_request_create_owner_privilege_candidate.sql"
  "0013_execution_request_decision_owner_privileges|20261123_execution_request_decision_owner_privilege_candidate.sql"
  "0014_durable_mission_scheduler|20261121_durable_mission_scheduler_candidate.sql"
  "0015_worker_principal_registry|20261122_worker_principal_registry_candidate.sql"
  "0016_worker_registry_owner_privileges|20261123_worker_registry_owner_privilege_candidate.sql"
  "0017_worker_scheduler_rpcs|20261122_worker_scheduler_rpc_candidate.sql"
  "0018_worker_scheduler_owner_privileges|20261123_worker_scheduler_rpc_owner_privilege_candidate.sql"
)

for entry in "${entries[@]}"; do
  migration_name="${entry%%|*}"
  source_name="${entry#*|}"
  source_file="$source_root/$source_name"
  [[ -s "$source_file" ]] || { echo "Missing or empty source draft: $source_name" >&2; exit 3; }
done

(
  cd "$tmp"
  printf '\n' | supabase init
  for entry in "${entries[@]}"; do
    migration_name="${entry%%|*}"
    source_name="${entry#*|}"
    supabase migration new "$migration_name"
    migration_file="$(find "$tmp/supabase/migrations" -maxdepth 1 -type f -name "*_${migration_name}.sql" -print -quit)"
    [[ -n "$migration_file" ]] || { echo "CLI did not create migration for $migration_name" >&2; exit 4; }
    cp "$source_root/$source_name" "$migration_file"
    sleep 1
  done
)

mkdir -p "$repo_root/supabase/migrations"
cp "$tmp/supabase/config.toml" "$repo_root/supabase/config.toml"
sed -i 's/^project_id = .*/project_id = "happy-base-local"/' "$repo_root/supabase/config.toml"
if [[ -f "$tmp/supabase/.gitignore" ]]; then
  cp "$tmp/supabase/.gitignore" "$repo_root/supabase/.gitignore"
fi
cp "$tmp"/supabase/migrations/*.sql "$repo_root/supabase/migrations/"

manifest="$repo_root/docs/security/supabase-staging-migration-chain.md"
mkdir -p "$(dirname "$manifest")"
{
  echo "# HAPPY Supabase staging migration chain"
  echo
  echo "**Status:** generated for isolated local replay; NOT approved for hosted apply."
  echo '**Generator:** Supabase CLI `supabase init` and `supabase migration new`.'
  echo "**PostgreSQL target:** local Supabase stack, PostgreSQL 17."
  echo
  echo "## Ordered source mapping"
  echo
  echo "| Order | Generated migration | Source draft |"
  echo "|---:|---|---|"
  i=0
  for entry in "${entries[@]}"; do
    i=$((i + 1))
    migration_name="${entry%%|*}"
    source_name="${entry#*|}"
    generated="$(find "$repo_root/supabase/migrations" -maxdepth 1 -type f -name "*_${migration_name}.sql" -printf '%f\n' -quit)"
    [[ -n "$generated" ]] || { echo "Generated migration missing: $migration_name" >&2; exit 5; }
    printf '| %02d | `%s` | `%s` |\n' "$i" "$generated" "$source_name"
  done
  echo
  echo "## Explicit exclusions"
  echo
  echo "- Superseded tenant-context and execution-request RPC design notes."
  echo "- Legacy file-mutation atomic-consume candidate."
  echo '- Worker registry and scheduler LOGIN grant candidates; worker EXECUTE grants remain withheld pending real dedicated-LOGIN and hosted-pooler `session_user` evidence.'
  echo
  echo "## Required gates"
  echo
  echo "- This chain is a faithful CLI-generated staging candidate, not a declaration that the SQL is safe to deploy."
  echo "- Clean local replay, owner/grant/RLS tests, and migration checksums must pass before any staging consideration."
  echo "- Real Supabase JWT tenant-isolation tests and hosted worker identity verification remain outstanding."
  echo "- No remote project is linked or mutated by this generator."
} > "$manifest"

(cd "$repo_root" && sha256sum supabase/migrations/*.sql > docs/security/supabase-staging-migration-checksums.sha256)
echo "Generated $(find "$repo_root/supabase/migrations" -maxdepth 1 -type f -name '*.sql' | wc -l | tr -d ' ') CLI migrations."
