-- Composed-schema adversarial boundary for the founder decision SECURITY DEFINER owner.
-- Runs after the exact tenant identity + execution envelope + owner privilege candidates.
-- Disposable PostgreSQL integration DB only; no hosted project or JWT signature claim.
BEGIN;

DO $owner_boundary$
DECLARE
  v_owner oid := 'happy_execution_request_decision_rpc_owner'::regrole;
  v_expected integer;
  v_actual integer;
  v_bad text;
  v_table text;
BEGIN
  -- The owner role is a non-login, non-bypass capability boundary and may be
  -- a member only of the trusted migration executor used for ALTER OWNER.
  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_roles
     WHERE oid=v_owner AND NOT rolcanlogin AND NOT rolinherit
       AND NOT rolsuper AND NOT rolcreatedb AND NOT rolcreaterole
       AND NOT rolreplication AND NOT rolbypassrls
  ) THEN
    RAISE EXCEPTION 'decision owner role has unsafe attributes';
  END IF;

  SELECT count(*) INTO v_actual
    FROM pg_catalog.pg_auth_members
   WHERE roleid=v_owner;
  IF v_actual <> 1 OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_auth_members m
    JOIN pg_catalog.pg_roles member ON member.oid=m.member
    WHERE m.roleid=v_owner AND member.rolname='postgres'
  ) THEN
    RAISE EXCEPTION 'decision owner membership is not restricted to postgres';
  END IF;

  -- The composed owner must own exactly the two intended SECURITY DEFINER
  -- functions: the internal boolean scope helper and the public decision RPC.
  SELECT count(*) INTO v_actual
    FROM pg_catalog.pg_proc p
   WHERE p.proowner=v_owner AND p.prosecdef;
  IF v_actual <> 2 THEN
    RAISE EXCEPTION 'decision owner SECURITY DEFINER function count expected 2, got %',v_actual;
  END IF;

  IF NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE p.proowner=v_owner AND p.prosecdef
      AND n.nspname='private'
      AND p.proname='happy_is_active_founder_approval_scope'
      AND pg_catalog.pg_get_function_identity_arguments(p.oid)='p_organization_id uuid, p_workspace_id uuid'
  ) OR NOT EXISTS (
    SELECT 1 FROM pg_catalog.pg_proc p
    JOIN pg_catalog.pg_namespace n ON n.oid=p.pronamespace
    WHERE p.proowner=v_owner AND p.prosecdef
      AND n.nspname='public'
      AND p.proname='decide_authenticated_execution_request'
      AND pg_catalog.pg_get_function_identity_arguments(p.oid)='p_request_id text, p_decision text, p_reason text'
  ) THEN
    RAISE EXCEPTION 'decision owner does not own the exact intended SECURITY DEFINER functions';
  END IF;

  -- No API identity can read private identity rows directly, assume the owner,
  -- or invoke the private scope helper. Only authenticated can invoke the
  -- public decision RPC.
  FOREACH v_table IN ARRAY ARRAY[
    'organizations','workspaces','organization_memberships','workspace_memberships'
  ] LOOP
    FOREACH v_bad IN ARRAY ARRAY['anon','authenticated','service_role'] LOOP
      IF has_table_privilege(v_bad,format('private.%I',v_table),'SELECT') THEN
        RAISE EXCEPTION 'API role % has direct SELECT on private.%',v_bad,v_table;
      END IF;
    END LOOP;
  END LOOP;

  IF pg_has_role('anon',v_owner,'MEMBER')
     OR pg_has_role('authenticated',v_owner,'MEMBER')
     OR pg_has_role('service_role',v_owner,'MEMBER')
     OR pg_has_role('authenticator',v_owner,'MEMBER') THEN
    RAISE EXCEPTION 'an API role can assume decision owner';
  END IF;

  IF has_function_privilege('anon',
       'private.happy_is_active_founder_approval_scope(uuid,uuid)','EXECUTE')
     OR has_function_privilege('authenticated',
       'private.happy_is_active_founder_approval_scope(uuid,uuid)','EXECUTE')
     OR has_function_privilege('service_role',
       'private.happy_is_active_founder_approval_scope(uuid,uuid)','EXECUTE')
     OR has_function_privilege('anon',
       'public.decide_authenticated_execution_request(text,text,text)','EXECUTE')
     OR has_function_privilege('service_role',
       'public.decide_authenticated_execution_request(text,text,text)','EXECUTE')
     OR NOT has_function_privilege('authenticated',
       'public.decide_authenticated_execution_request(text,text,text)','EXECUTE') THEN
    RAISE EXCEPTION 'decision/helper EXECUTE ACL is broader or narrower than intended';
  END IF;
END
$owner_boundary$;

-- Exercise actual SELECT permissions as each API database role. Metadata alone
-- is insufficient: a successful zero-row SELECT would still be a disclosure
-- surface, so every direct query must raise insufficient_privilege.
SET ROLE anon;
DO $direct_read_anon$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','workspaces','organization_memberships','workspace_memberships'] LOOP
    BEGIN
      EXECUTE format('SELECT 1 FROM private.%I LIMIT 1',t);
      RAISE EXCEPTION 'anon directly selected private.%',t;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
END
$direct_read_anon$;
RESET ROLE;

SET ROLE authenticated;
DO $direct_read_authenticated$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','workspaces','organization_memberships','workspace_memberships'] LOOP
    BEGIN
      EXECUTE format('SELECT 1 FROM private.%I LIMIT 1',t);
      RAISE EXCEPTION 'authenticated directly selected private.%',t;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
  BEGIN
    PERFORM private.happy_is_active_founder_approval_scope(
      '10000000-0000-4000-8000-000000000001',
      '20000000-0000-4000-8000-000000000002'
    );
    RAISE EXCEPTION 'authenticated executed internal founder scope helper';
  EXCEPTION WHEN insufficient_privilege THEN NULL;
  END;
END
$direct_read_authenticated$;
RESET ROLE;

SET ROLE service_role;
DO $direct_read_service_role$
DECLARE t text;
BEGIN
  FOREACH t IN ARRAY ARRAY['organizations','workspaces','organization_memberships','workspace_memberships'] LOOP
    BEGIN
      EXECUTE format('SELECT 1 FROM private.%I LIMIT 1',t);
      RAISE EXCEPTION 'service_role directly selected private.%',t;
    EXCEPTION WHEN insufficient_privilege THEN NULL;
    END;
  END LOOP;
END
$direct_read_service_role$;
RESET ROLE;

SELECT 'Composed founder decision owner boundary: PASS' AS result;
ROLLBACK;
