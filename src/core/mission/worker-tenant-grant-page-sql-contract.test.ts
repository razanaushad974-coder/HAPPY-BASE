import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  "supabase/drafts/20261127_worker_tenant_grant_page_rpc_candidate.sql",
  "utf8",
);
assert.match(sql, /happy_require_worker_principal\('CONTROL'\)/);
assert.match(sql, /g\.worker_principal_id = v_session_principal_id/);
assert.match(sql, /g\.enabled = true/);
assert.match(sql, /g\.capabilities @> array\['CONTROL'\]::text\[\]/);
assert.match(sql, /o\.status = 'ACTIVE'/);
assert.match(sql, /w\.status = 'ACTIVE'/);
assert.match(sql, /om\.status = 'ACTIVE'/);
assert.match(sql, /wm\.status = 'ACTIVE'/);
assert.match(sql, /p_limit < 1 or p_limit > 20/);
assert.match(sql, /for share of g, o, w, om, wm/i);
assert.match(sql, /owner to happy_worker_registry_owner/i);
assert.match(sql, /revoke all on function private\.happy_worker_list_tenant_grants/i);
assert.match(sql, /intentionally no GRANT EXECUTE/i);
assert.doesNotMatch(sql, /grant execute on function private\.happy_worker_list_tenant_grants/i);
assert.doesNotMatch(sql, /grant execute on all functions/i);

console.log("Worker tenant-grant SQL contract: PASS");
