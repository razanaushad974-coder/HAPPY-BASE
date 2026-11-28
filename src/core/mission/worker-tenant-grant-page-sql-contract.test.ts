import assert from "node:assert/strict";
import { readFileSync } from "node:fs";

const sql = readFileSync(
  "supabase/drafts/20261127_worker_tenant_grant_page_rpc_candidate.sql",
  "utf8",
);
const registryRole = readFileSync(
  "supabase/migrations/20261124122934_0003_worker_registry_owner_role.sql",
  "utf8",
);
const registryPrivileges = readFileSync(
  "supabase/migrations/20261124122959_0016_worker_registry_owner_privileges.sql",
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
assert.match(sql, /revoke all on function private\.happy_worker_list_tenant_grants[\s\S]*?from %I/i);
assert.ok(sql.includes("where rolname ~ '^happy_worker_[a-z0-9_]{1,48}$'"));

// The RPC's SECURITY DEFINER owner must be a non-login, non-bypass role.
// PostgreSQL session_user is the identity source; the role is never inherited
// by a worker LOGIN or API role.
assert.match(registryRole, /create role happy_worker_registry_owner[\s\S]*?nologin noinherit nosuperuser nocreatedb nocreaterole[\s\S]*?nobypassrls/i);
assert.match(registryRole, /grant happy_worker_registry_owner to postgres/i);
assert.doesNotMatch(registryRole, /grant happy_worker_registry_owner to (?:anon|authenticated|service_role|authenticator|happy_worker_[a-z0-9_]+)/i);

// The owner receives only the columns required for reads and row locks.
// The UPDATE grants are intentionally limited to one status/enabled column.
assert.match(registryPrivileges, /grant usage on schema private to happy_worker_registry_owner/i);
assert.match(registryPrivileges, /grant select \([\s\S]*?\) on private\.happy_worker_principal_registry to happy_worker_registry_owner/i);
assert.match(registryPrivileges, /grant select \([\s\S]*?\) on private\.happy_worker_tenant_grants to happy_worker_registry_owner/i);
for (const table of [
  "happy_worker_principal_registry",
  "happy_worker_tenant_grants",
]) {
  assert.match(
    registryPrivileges,
    new RegExp("grant update \\(enabled\\)[\\s\\S]*?on private\\." + table + " to happy_worker_registry_owner", "i"),
  );
}
for (const table of [
  "organizations",
  "workspaces",
  "organization_memberships",
  "workspace_memberships",
]) {
  assert.match(
    registryPrivileges,
    new RegExp("grant update \\(status\\)[\\s\\S]*?on private\\." + table + " to happy_worker_registry_owner", "i"),
  );
}
assert.match(registryPrivileges, /alter function private\.happy_require_worker_principal\(text\)[\s\S]*?owner to happy_worker_registry_owner/i);
assert.match(registryPrivileges, /revoke create on schema private from happy_worker_registry_owner/i);
assert.match(registryPrivileges, /has_table_privilege\('happy_worker_registry_owner'[\s\S]*?'INSERT'\)/i);
assert.match(registryPrivileges, /has_table_privilege\('happy_worker_registry_owner'[\s\S]*?'DELETE'\)/i);
assert.match(registryPrivileges, /revoke all on function private\.happy_require_worker_principal/i);

console.log("Worker tenant-grant SQL and owner privilege contract: PASS");

// The RPC's SECURITY DEFINER owner must be a non-login, non-bypass role.
// PostgreSQL session_user is the identity source; the role is never inherited
// by a worker LOGIN or API role.
assert.match(registryRole, /create role happy_worker_registry_owner[\s\S]*?nologin noinherit nosuperuser nocreatedb nocreaterole[\s\S]*?nobypassrls/i);
assert.match(registryRole, /grant happy_worker_registry_owner to postgres/i);
assert.doesNotMatch(registryRole, /grant happy_worker_registry_owner to (?:anon|authenticated|service_role|authenticator|happy_worker_[a-z0-9_]+)/i);

// The owner receives only the columns required for reads and row locks.
// The UPDATE grants are intentionally limited to one status/enabled column.
assert.match(registryPrivileges, /grant usage on schema private to happy_worker_registry_owner/i);
assert.match(registryPrivileges, /grant select \([\s\S]*?\) on private\.happy_worker_principal_registry to happy_worker_registry_owner/i);
assert.match(registryPrivileges, /grant select \([\s\S]*?\) on private\.happy_worker_tenant_grants to happy_worker_registry_owner/i);
for (const table of [
  "happy_worker_principal_registry",
  "happy_worker_tenant_grants",
]) {
  assert.match(
    registryPrivileges,
    new RegExp("grant update \\(enabled\\)[\\s\\S]*?on private\\." + table + " to happy_worker_registry_owner", "i"),
  );
}
for (const table of [
  "organizations",
  "workspaces",
  "organization_memberships",
  "workspace_memberships",
]) {
  assert.match(
    registryPrivileges,
    new RegExp("grant update \\(status\\)[\\s\\S]*?on private\\." + table + " to happy_worker_registry_owner", "i"),
  );
}
assert.match(registryPrivileges, /alter function private\.happy_require_worker_principal\(text\)[\s\S]*?owner to happy_worker_registry_owner/i);
assert.match(registryPrivileges, /revoke create on schema private from happy_worker_registry_owner/i);
assert.match(registryPrivileges, /has_table_privilege\('happy_worker_registry_owner'[\s\S]*?'INSERT'\)/i);
assert.match(registryPrivileges, /has_table_privilege\('happy_worker_registry_owner'[\s\S]*?'DELETE'\)/i);
assert.match(registryPrivileges, /revoke all on function private\.happy_require_worker_principal/i);

console.log("Worker tenant-grant SQL and owner privilege contract: PASS");
