# Canonical identity and file-mutation baseline: security blocker audit

**Status:** BLOCKED — design review only. This document does not authorize migration creation or database apply.
**Reviewed source:** `supabase/drafts/20261119_file_mutation_atomic_consume_candidate.sql`
**Scope:** privilege boundary, SECURITY DEFINER ownership, tenant isolation and migration dependency readiness.

## Findings

### P0 — broad service_role access to canonical tenant and execution tables

The candidate grants `service_role` schema USAGE and SELECT/INSERT/UPDATE on all of:

- `private.organizations`
- `private.workspaces`
- `private.organization_memberships`
- `private.workspace_memberships`
- `private.execution_requests`

It also grants SELECT/INSERT on all file approval grant and event rows. These are unscoped table privileges, not capability-scoped RPC access. Supabase `service_role` is a privileged API role and bypasses RLS; therefore RLS enablement does not constrain these grants.

**Required correction:** remove runtime table grants to `service_role`. Define separate NOLOGIN/NOBYPASSRLS function-owner roles with exact schema/table/column privileges and row-lock RLS policies. Expose only narrowly scoped SECURITY DEFINER RPCs with explicit function owners, fixed search paths, PUBLIC/anon/service_role EXECUTE revoked, and exact authenticated or worker capability grants. Do not replace this with broad grants to another runtime role.

### P0 — SECURITY DEFINER function has no explicit safe owner contract

`public.consume_file_mutation_approval_grant(...)` is SECURITY DEFINER, but this candidate does not explicitly provision a dedicated NOLOGIN/NOBYPASSRLS owner, transfer ownership, define exact owner privileges, or prove RLS behavior for its table reads and `FOR UPDATE` locks.

The function reads and updates private tenant, membership, request, approval and event data. Its effective authority is therefore determined by the migration executor's default function owner unless a later migration changes it.

**Required correction:** introduce a dedicated `happy_file_mutation_consume_rpc_owner` (NOLOGIN, NOINHERIT, NOSUPERUSER, NOCREATEROLE, NOCREATEDB, NOREPLICATION, NOBYPASSRLS), with no API/worker memberships. Assign only this function to it. Grant exact SELECT and lock-only/update column privileges required by the function; pair row locks with owner-targeted RLS policies that prevent unauthorized row mutation. Test all reads, FOR UPDATE locks, UPDATE predicates, and RLS outcomes under SET ROLE as that owner. Do not use hosted `postgres` as the permanent runtime owner.

### P1 — identity baseline and file-mutation capability are coupled

The same candidate creates organization/workspace identity, memberships, execution requests, file approval grants, audit events, triggers, and the consumption RPC. This makes it a high-blast-radius predecessor for every downstream tenant, approval, scheduler and worker migration.

**Required correction:** split the design into independently reviewable stages:
1. canonical tenant identity tables and constraints;
2. tenant membership/authorization RPCs and their non-bypass owner;
3. execution-request/approval envelope and immutable evidence;
4. file-mutation-specific grant/event tables and consume RPC.

Do not create a migration by copying this combined draft wholesale.

### P1 — table RLS is enabled without a complete policy/owner matrix in this candidate

RLS is enabled on the seven private tables, but the candidate itself does not define a complete policy set for the intended function owner and authenticated operations. Direct service_role grants effectively bypass that boundary. Removing those grants without first designing and testing owner policies would simply break legitimate RPC execution.

**Required correction:** specify, per table and per operation, the function owner, exact columns, SELECT/INSERT/UPDATE/DELETE privilege, row-lock requirement, RLS USING/WITH CHECK predicates, and allowed caller RPC. Include negative tests for cross-tenant reads, unauthorized membership changes, and direct API-role access.

### P1 — public RPC execution is only partially constrained

The candidate revokes the consume function from PUBLIC, anon and service_role and grants it to authenticated. It does not include an explicit owner transfer or a complete authenticated JWT adversarial test suite in this migration candidate.

**Required correction:** bind function owner and exact signature in a dedicated owner/grant candidate; test real Supabase JWT subject binding, requester/executor/approver separation, revoked membership, cross-workspace attempts, stale/replayed grants, and transaction rollback before staging apply.

## Migration dependency decision

This file remains a design-only dependency candidate, **not an approved canonical identity migration**. The downstream tenant persistence, approval envelope, durable scheduler and worker registry must not be applied against an assumed schema derived from it until the baseline is split, owner model is implemented, and acceptance tests pass.

## Verification plan

- [ ] Static inventory of all references to the seven private tables and consume RPC.
- [ ] Dedicated file-consume owner role and exact privilege/RLS candidate reviewed.
- [ ] PostgreSQL 17 adversarial tests for SELECT, INSERT, UPDATE, DELETE and FOR UPDATE under the owner role.
- [ ] Real Supabase JWT tests for tenant isolation and approval binding.
- [ ] Direct access denied for PUBLIC, anon, authenticated and service_role where no RPC is intended.
- [ ] Migration replay from an empty disposable database with checksums and rollback/forward-fix plan.
- [ ] Explicit approval before applying any migration to `happy-worker-staging`.

**Current result:** NOT READY. No staging or production database changes were made as part of this audit.
