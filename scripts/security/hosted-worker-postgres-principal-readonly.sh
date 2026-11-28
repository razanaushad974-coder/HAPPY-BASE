#!/usr/bin/env bash
set -euo pipefail
set +x

if [[ -z "${HAPPY_STAGING_WORKER_DATABASE_URL:-}" ]]; then
  echo "HAPPY_STAGING_DB_PRINCIPAL_PREFLIGHT=BLOCKED_SECRET_NOT_CONFIGURED"
  echo "No database connection was attempted."
  # A blocked gate must not produce a green workflow run.
  exit 3
fi

if ! command -v psql >/dev/null 2>&1; then
  echo "psql client is required." >&2
  exit 2
fi

# One read-only transaction through the exact staging pooler URL supplied by
# the protected GitHub Environment secret. Never print the URL or credentials.
result="$(
  PGCONNECT_TIMEOUT=5 psql -X -w -qAt -v ON_ERROR_STOP=1 -F '|' \
    "$HAPPY_STAGING_WORKER_DATABASE_URL" \
    -c "BEGIN READ ONLY;
        SELECT session_user,
               current_user,
               current_setting('role'),
               current_database(),
               current_setting('transaction_read_only');
        ROLLBACK;"
)"

IFS='|' read -r session_user current_user active_role database_name read_only <<< "$result"
if [[ "$session_user" != "happy_worker_dispatch" ||
      "$current_user" != "happy_worker_dispatch" ||
      "$active_role" != "none" ||
      -z "$database_name" ||
      "$read_only" != "on" ]]; then
  echo "HAPPY_STAGING_DB_PRINCIPAL_PREFLIGHT=FAIL"
  echo "Observed session_user=$session_user current_user=$current_user active_role=$active_role database=$database_name read_only=$read_only"
  exit 1
fi

echo "HAPPY_STAGING_DB_PRINCIPAL_PREFLIGHT=PASS"
echo "session_user=$session_user"
echo "current_user=$current_user"
echo "active_role=$active_role"
echo "database=$database_name"
echo "transaction_read_only=$read_only"
