-- DESIGN-ONLY canonical tenant identity baseline.
-- DO NOT APPLY to a connected/shared/production Supabase project.
--
-- This is the isolated Stage 0 replacement for the identity-table portion of
-- 20261119_file_mutation_atomic_consume_candidate.sql. It intentionally does
-- NOT create execution requests, file-mutation grants/events, SECURITY DEFINER
-- functions, service_role grants, or runtime memberships.
--
-- Follow-up owner/RLS candidates must provide narrowly scoped access. These
-- tables start with RLS enabled and no runtime table grants/policies.
BEGIN;

CREATE SCHEMA IF NOT EXISTS private;

CREATE TABLE private.organizations (
  organization_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp()
);

CREATE TABLE private.workspaces (
  workspace_id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  organization_id uuid NOT NULL
    REFERENCES private.organizations(organization_id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED')),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT happy_workspaces_org_workspace_unique
    UNIQUE (organization_id,workspace_id)
);

CREATE TABLE private.organization_memberships (
  organization_id uuid NOT NULL
    REFERENCES private.organizations(organization_id) ON DELETE RESTRICT,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED')),
  role text NOT NULL CHECK (length(btrim(role)) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,user_id)
);

CREATE TABLE private.workspace_memberships (
  organization_id uuid NOT NULL,
  workspace_id uuid NOT NULL,
  user_id uuid NOT NULL REFERENCES auth.users(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'ACTIVE'
    CHECK (status IN ('ACTIVE','SUSPENDED','REVOKED')),
  role text NOT NULL CHECK (length(btrim(role)) BETWEEN 1 AND 64),
  created_at timestamptz NOT NULL DEFAULT clock_timestamp(),
  PRIMARY KEY (organization_id,workspace_id,user_id),
  CONSTRAINT happy_workspace_memberships_workspace_fk
    FOREIGN KEY (organization_id,workspace_id)
    REFERENCES private.workspaces(organization_id,workspace_id)
    ON DELETE RESTRICT
);

CREATE INDEX happy_organization_memberships_user_idx
  ON private.organization_memberships(user_id,organization_id);
CREATE INDEX happy_workspace_memberships_user_idx
  ON private.workspace_memberships(user_id,organization_id,workspace_id);

ALTER TABLE private.organizations ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.workspaces ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.organization_memberships ENABLE ROW LEVEL SECURITY;
ALTER TABLE private.workspace_memberships ENABLE ROW LEVEL SECURITY;

-- The private schema is not an API surface. Later SECURITY DEFINER owners
-- receive USAGE explicitly in their own privilege candidates.
REVOKE ALL ON SCHEMA private FROM PUBLIC,anon,authenticated,service_role;

REVOKE ALL ON TABLE
  private.organizations,
  private.workspaces,
  private.organization_memberships,
  private.workspace_memberships
FROM PUBLIC,anon,authenticated,service_role;

COMMENT ON SCHEMA private IS
  'Non-exposed HAPPY internal schema. Access is granted only through reviewed owner/RPC boundaries.';
COMMENT ON TABLE private.organizations IS
  'Canonical HAPPY organization identity and lifecycle state.';
COMMENT ON TABLE private.workspaces IS
  'Canonical workspace identity, bound to one organization.';
COMMENT ON TABLE private.organization_memberships IS
  'Canonical organization membership and role; runtime access requires reviewed scoped RPCs.';
COMMENT ON TABLE private.workspace_memberships IS
  'Canonical workspace membership and role; runtime access requires reviewed scoped RPCs.';

COMMIT;
