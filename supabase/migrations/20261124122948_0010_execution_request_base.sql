-- DESIGN-ONLY minimal execution request base table.
-- DO NOT APPLY to a connected/shared/production Supabase project.
--
-- This is separated from the authenticated execution envelope so Stage 0
-- identity tables remain capability-neutral. The following envelope draft
-- adds immutable intent, idempotency, founder approval evidence and RPCs:
--   20261121_authenticated_execution_envelope_candidate.sql
-- Do not use the legacy execution_requests definition embedded in the blocked
-- file-mutation candidate as a migration dependency.
BEGIN;

CREATE TABLE private.execution_requests (
  request_id text PRIMARY KEY
    CHECK (length(btrim(request_id)) BETWEEN 1 AND 160),
  task_id text NOT NULL CHECK (length(btrim(task_id)) BETWEEN 1 AND 160),
  mission_id text NOT NULL CHECK (length(btrim(mission_id)) BETWEEN 1 AND 160),
  requester_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  executor_user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  organization_id uuid NOT NULL
    REFERENCES private.organizations(organization_id) ON DELETE RESTRICT,
  workspace_id uuid NOT NULL,
  status text NOT NULL DEFAULT 'RECEIVED',
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT happy_execution_requests_workspace_fk
    FOREIGN KEY (organization_id,workspace_id)
    REFERENCES private.workspaces(organization_id,workspace_id)
    ON DELETE RESTRICT
);

CREATE INDEX happy_execution_requests_scope_created_idx
  ON private.execution_requests(organization_id,workspace_id,requester_user_id,created_at DESC);

ALTER TABLE private.execution_requests ENABLE ROW LEVEL SECURITY;
REVOKE ALL ON TABLE private.execution_requests
  FROM PUBLIC,anon,authenticated,service_role;

COMMENT ON TABLE private.execution_requests IS
  'Minimal tenant-bound execution request base; executable intent and approval state are added only by the reviewed envelope RPC layer.';

COMMIT;
