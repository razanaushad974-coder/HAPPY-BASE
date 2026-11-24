# HAPPY Supabase staging migration chain

**Status:** generated for isolated local replay; NOT approved for hosted apply.
**Generator:** Supabase CLI `supabase init` and `supabase migration new`.
**PostgreSQL target:** local Supabase stack, PostgreSQL 17.

## Ordered source mapping

| Order | Generated migration | Source draft |
|---:|---|---|
| 01 | `20261124122931_0001_canonical_tenant_identity.sql` | `20261123_canonical_tenant_identity_schema_candidate.sql` |
| 02 | `20261124122933_0002_tenant_scope_owner_role.sql` | `20261123_tenant_scope_rpc_owner_role_candidate.sql` |
| 03 | `20261124122934_0003_worker_registry_owner_role.sql` | `20261123_worker_registry_owner_role_candidate.sql` |
| 04 | `20261124122936_0004_execution_request_create_owner_role.sql` | `20261123_execution_request_create_owner_role_candidate.sql` |
| 05 | `20261124122938_0005_execution_request_decision_owner_role.sql` | `20261123_execution_request_decision_owner_role_candidate.sql` |
| 06 | `20261124122940_0006_worker_scheduler_owner_role.sql` | `20261123_worker_scheduler_rpc_owner_role_candidate.sql` |
| 07 | `20261124122942_0007_tenant_scope_authenticated_user_accessor.sql` | `20261124_authenticated_user_id_accessor_bootstrap_candidate.sql` |
| 08 | `20261124122944_0008_async_tenant_persistence.sql` | `20261119_async_tenant_persistence_schema_candidate.sql` |
| 09 | `20261124122946_0009_tenant_scope_owner_privileges.sql` | `20261123_tenant_scope_rpc_owner_privilege_candidate.sql` |
| 10 | `20261124122948_0010_execution_request_base.sql` | `20261123_execution_request_base_schema_candidate.sql` |
| 11 | `20261124122950_0011_authenticated_execution_envelope.sql` | `20261121_authenticated_execution_envelope_candidate.sql` |
| 12 | `20261124122952_0012_execution_request_create_owner_privileges.sql` | `20261123_execution_request_create_owner_privilege_candidate.sql` |
| 13 | `20261124122954_0013_execution_request_decision_owner_privileges.sql` | `20261123_execution_request_decision_owner_privilege_candidate.sql` |
| 14 | `20261124122955_0014_durable_mission_scheduler.sql` | `20261121_durable_mission_scheduler_candidate.sql` |
| 15 | `20261124122957_0015_worker_principal_registry.sql` | `20261122_worker_principal_registry_candidate.sql` |
| 16 | `20261124122959_0016_worker_registry_owner_privileges.sql` | `20261123_worker_registry_owner_privilege_candidate.sql` |
| 17 | `20261124123001_0017_worker_scheduler_rpcs.sql` | `20261122_worker_scheduler_rpc_candidate.sql` |
| 18 | `20261124123003_0018_worker_scheduler_owner_privileges.sql` | `20261123_worker_scheduler_rpc_owner_privilege_candidate.sql` |

## Explicit exclusions

- Superseded tenant-context and execution-request RPC design notes.
- Legacy file-mutation atomic-consume candidate.
- Worker registry and scheduler LOGIN grant candidates; worker EXECUTE grants remain withheld pending real dedicated-LOGIN and hosted-pooler `session_user` evidence.

## Required gates

- This chain is a faithful CLI-generated staging candidate, not a declaration that the SQL is safe to deploy.
- Clean local replay, owner/grant/RLS tests, and migration checksums must pass before any staging consideration.
- Real Supabase JWT tenant-isolation tests and hosted worker identity verification remain outstanding.
- No remote project is linked or mutated by this generator.
