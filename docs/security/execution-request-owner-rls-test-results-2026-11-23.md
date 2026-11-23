# Execution-request RPC owner / RLS probe results — 2026-11-23

## Results

**PASS — both synthetic PostgreSQL 17.12 integration probes completed on hosted `happy-worker-staging` and rolled back.**

### Create / resolve owner

- Script: `scripts/security/test-execution-request-create-owner-grants.sql`
- Blob SHA: `8f5e1247e0a6f123844e73bba4f349697b0c795c`
- Verified self-execution request creation as inert `WAITING_APPROVAL` / `PENDING`.
- Verified mission/task selectors are bound to same-user, same-tenant persisted records.
- Verified idempotency retry with a different proposed request ID returns the original persisted request.
- Verified resolver returns the caller's own request and does not reveal it to a different JWT subject.
- Owner is NOLOGIN/NOBYPASSRLS in the fixture; RLS constrains request SELECT/INSERT and mission/task SELECT.

### Founder decision owner

- Script: `scripts/security/test-execution-request-decision-owner-grants.sql`
- Blob SHA: `7282c46225b05ff4ff5026e7223f3b9c852916bf`
- Verified `FOR UPDATE` row locks on organization, workspace, request, and membership rows using lock-only UPDATE policies.
- Verified an active founder can approve a different user's pending request.
- Verified self-approval is rejected.
- Verified a non-founder cannot approve.
- Verified request state becomes `READY / APPROVED` and exactly one matching append-only approval event is inserted.
- Verified request UPDATE policy permits only the approved/rejected transition with current actor, timestamp and reason.
- Verified identity lock-only policies use `USING (true) WITH CHECK (false)`, preventing identity-row mutation.

The SQL tool returned without assertion errors. Both scripts ended in `ROLLBACK`; a final catalog check confirmed all probe roles and schemas were absent.

## Candidate changes

- Added separate NOLOGIN/NOBYPASSRLS role candidates for execution-request creation/resolution and founder decisions.
- Added separate least-privilege RLS/grant candidates for each role.
- Replaced direct `auth.uid()` calls in the execution-request RPC bodies with the private JWT-subject accessor established by the tenant-scope owner work.
- Replaced the execution-request update trigger guard's unnecessary SECURITY DEFINER declaration with SECURITY INVOKER.
- Retired the intermediate `20261121_authenticated_execution_request_rpc_candidate.sql` containing the rejected BYPASSRLS owner; it now contains comments only and no executable SQL.
- The final envelope candidate revokes default PUBLIC/API execution before the separate owner/grant candidates grant authenticated EXECUTE.

## Remaining gates

- Test the candidate SQL against the actual HAPPY prerequisite schema and migration order; staging still intentionally contains no HAPPY tables or migrations.
- Validate real JWT/API calls rather than manually setting `request.jwt.claim.sub` in a synthetic SQL fixture.
- Run concurrent founder decisions, membership revocation, and request cancellation in two PostgreSQL sessions.
- Verify actual function ownership, grants, RLS policies, trigger execution and catalog ACLs after a reviewed staging migration chain.
- Do not provision worker credentials or grant worker scheduler RPC EXECUTE until the dedicated PostgreSQL LOGIN and hosted pooler `session_user` are proven.

**Disposition: PARTIAL PASS — create/resolve and founder-decision owner/RLS patterns passed synthetic PostgreSQL 17.12 tests. Actual HAPPY schema integration and concurrency verification remain pending.**
