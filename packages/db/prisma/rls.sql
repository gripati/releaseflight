-- Enable Row-Level Security on every tenant-scoped table and apply
-- a uniform tenant_isolation policy that uses the per-transaction
-- `app.current_tenant` GUC set by the Prisma middleware.
--
-- HOW IT WORKS:
--   1. The route handler middleware extracts the active tenantId from the
--      session and runs the request inside `tenantStorage.run({ tenantId })`.
--   2. Prisma middleware reads tenantStorage at query time and executes
--      `SET LOCAL app.current_tenant = '<uuid>'` inside the transaction.
--   3. RLS policies below filter rows by matching tenantId against the GUC.
--   4. If the GUC is NULL (no context), policies evaluate to FALSE -> no rows.
--
-- IMPORTANT:
--   • FORCE ROW LEVEL SECURITY is set so even the table OWNER (Prisma role)
--     obeys policies. Only roles with BYPASSRLS skip them.
--   • A separate `gp_migration_admin` role exists for migrations and cron
--     jobs that need cross-tenant access.

-- ────────────────────────────────────────────────────────────────────────
-- Reusable helper function
-- ────────────────────────────────────────────────────────────────────────

CREATE OR REPLACE FUNCTION current_tenant_id() RETURNS uuid AS $$
  SELECT NULLIF(current_setting('app.current_tenant', true), '')::uuid;
$$ LANGUAGE sql STABLE;

-- Idempotent: each policy is dropped-if-exists before (re)creation so this
-- script can be re-run safely (e.g. after adding a new tenant-scoped table)
-- without aborting on "policy already exists". Postgres has no
-- CREATE POLICY IF NOT EXISTS, so DROP-then-CREATE is the portable idiom.
CREATE OR REPLACE FUNCTION apply_tenant_isolation(table_name text) RETURNS void AS $$
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);

  EXECUTE format('DROP POLICY IF EXISTS tenant_iso_sel ON %I', table_name);
  EXECUTE format(
    'CREATE POLICY tenant_iso_sel ON %I FOR SELECT
       USING ("tenantId" = current_tenant_id())', table_name);

  EXECUTE format('DROP POLICY IF EXISTS tenant_iso_ins ON %I', table_name);
  EXECUTE format(
    'CREATE POLICY tenant_iso_ins ON %I FOR INSERT
       WITH CHECK ("tenantId" = current_tenant_id())', table_name);

  EXECUTE format('DROP POLICY IF EXISTS tenant_iso_upd ON %I', table_name);
  EXECUTE format(
    'CREATE POLICY tenant_iso_upd ON %I FOR UPDATE
       USING ("tenantId" = current_tenant_id())
       WITH CHECK ("tenantId" = current_tenant_id())', table_name);

  EXECUTE format('DROP POLICY IF EXISTS tenant_iso_del ON %I', table_name);
  EXECUTE format(
    'CREATE POLICY tenant_iso_del ON %I FOR DELETE
       USING ("tenantId" = current_tenant_id())', table_name);
END;
$$ LANGUAGE plpgsql;

-- ────────────────────────────────────────────────────────────────────────
-- Per-member app scoping (allowedAppIds)
-- ────────────────────────────────────────────────────────────────────────
--
-- A TenantMember may be restricted to a subset of the workspace's apps via
-- `TenantMember.allowedAppIds`. The Prisma extension publishes that list as a
-- comma-joined `app.allowed_app_ids` GUC alongside `app.current_tenant`.
--
--   • EMPTY / unset GUC  -> unrestricted (every app in the tenant).
--   • Non-empty GUC      -> only rows whose app id is in the list are visible.
--
-- These are RESTRICTIVE policies, so they are ANDed with the permissive
-- tenant_isolation policy above (effective = tenant match AND app in scope).
-- NULL app ids (e.g. tenant-level Job/AuditEvent rows) are always allowed —
-- they are already constrained by tenant isolation.
CREATE OR REPLACE FUNCTION allowed_app_ids() RETURNS uuid[] AS $$
  SELECT CASE
    WHEN NULLIF(current_setting('app.allowed_app_ids', true), '') IS NULL
      THEN NULL
    ELSE string_to_array(current_setting('app.allowed_app_ids', true), ',')::uuid[]
  END;
$$ LANGUAGE sql STABLE;

-- `id_col` is the column holding the app id: 'id' for the App table itself,
-- '"appId"' for child tables.
CREATE OR REPLACE FUNCTION apply_app_scope(table_name text, id_col text) RETURNS void AS $$
DECLARE
  predicate text := format(
    '(allowed_app_ids() IS NULL OR %s IS NULL OR %s = ANY(allowed_app_ids()))',
    id_col, id_col);
BEGIN
  EXECUTE format('ALTER TABLE %I ENABLE ROW LEVEL SECURITY', table_name);
  EXECUTE format('ALTER TABLE %I FORCE ROW LEVEL SECURITY', table_name);

  EXECUTE format('DROP POLICY IF EXISTS app_scope_sel ON %I', table_name);
  EXECUTE format(
    'CREATE POLICY app_scope_sel ON %I AS RESTRICTIVE FOR SELECT USING %s',
    table_name, predicate);

  EXECUTE format('DROP POLICY IF EXISTS app_scope_ins ON %I', table_name);
  EXECUTE format(
    'CREATE POLICY app_scope_ins ON %I AS RESTRICTIVE FOR INSERT WITH CHECK %s',
    table_name, predicate);

  EXECUTE format('DROP POLICY IF EXISTS app_scope_upd ON %I', table_name);
  EXECUTE format(
    'CREATE POLICY app_scope_upd ON %I AS RESTRICTIVE FOR UPDATE USING %s WITH CHECK %s',
    table_name, predicate, predicate);

  EXECUTE format('DROP POLICY IF EXISTS app_scope_del ON %I', table_name);
  EXECUTE format(
    'CREATE POLICY app_scope_del ON %I AS RESTRICTIVE FOR DELETE USING %s',
    table_name, predicate);
END;
$$ LANGUAGE plpgsql;

-- ────────────────────────────────────────────────────────────────────────
-- Apply policies to every tenant-scoped table
-- ────────────────────────────────────────────────────────────────────────

SELECT apply_tenant_isolation('Credential');
SELECT apply_tenant_isolation('App');
SELECT apply_tenant_isolation('AppLocalization');
SELECT apply_tenant_isolation('Screenshot');
SELECT apply_tenant_isolation('AppPreview');
SELECT apply_tenant_isolation('AndroidImage');
SELECT apply_tenant_isolation('Job');
SELECT apply_tenant_isolation('AuditEvent');

-- TenantSetting and UsageRecord have composite primary keys; same rule applies
SELECT apply_tenant_isolation('TenantSetting');
SELECT apply_tenant_isolation('UsageRecord');

-- Subscription is 1-1 with Tenant; still scope it
SELECT apply_tenant_isolation('Subscription');

-- ASO Intelligence — Phase 9 tables (see docs/16_ASO_INTELLIGENCE.md)
SELECT apply_tenant_isolation('AnalyticsSnapshot');
SELECT apply_tenant_isolation('AnalyticsFunnel');
SELECT apply_tenant_isolation('TrackedKeyword');
SELECT apply_tenant_isolation('KeywordSignal');
SELECT apply_tenant_isolation('AiUsage');
SELECT apply_tenant_isolation('AiKeywordSuggestion');
SELECT apply_tenant_isolation('LearnedNoiseTerm');
SELECT apply_tenant_isolation('AiRelevanceCache');
SELECT apply_tenant_isolation('Competitor');
SELECT apply_tenant_isolation('CompetitorRank');
SELECT apply_tenant_isolation('CompetitorSnapshot');
SELECT apply_tenant_isolation('MetadataSnapshot');
SELECT apply_tenant_isolation('AsoDailyCheck');
SELECT apply_tenant_isolation('AsoAlarm');
SELECT apply_tenant_isolation('AsoNotification');

-- Build & Ship pipeline (Deploy tab)
SELECT apply_tenant_isolation('AppConnection');
SELECT apply_tenant_isolation('AppBuildConfig');
SELECT apply_tenant_isolation('Build');
-- NOTE: Runner is deliberately NOT isolated — it is global infra (a build
-- machine serves every tenant) with no tenantId column, like TenantMember.

-- ────────────────────────────────────────────────────────────────────────
-- Per-member app scoping — App table (keyed on id) + every app-owned child
-- table (keyed on "appId"). RESTRICTIVE, so ANDed with tenant isolation.
-- ────────────────────────────────────────────────────────────────────────
SELECT apply_app_scope('App', 'id');
SELECT apply_app_scope('AppLocalization', '"appId"');
SELECT apply_app_scope('Screenshot', '"appId"');
SELECT apply_app_scope('AppPreview', '"appId"');
SELECT apply_app_scope('AndroidImage', '"appId"');
SELECT apply_app_scope('AiKeywordSuggestion', '"appId"');
SELECT apply_app_scope('AnalyticsSnapshot', '"appId"');
SELECT apply_app_scope('AnalyticsFunnel', '"appId"');
SELECT apply_app_scope('TrackedKeyword', '"appId"');
SELECT apply_app_scope('Competitor', '"appId"');
SELECT apply_app_scope('MetadataSnapshot', '"appId"');
SELECT apply_app_scope('AsoDailyCheck', '"appId"');
SELECT apply_app_scope('AsoNotification', '"appId"');
SELECT apply_app_scope('AiRelevanceCache', '"appId"');
SELECT apply_app_scope('AppConnection', '"appId"');
SELECT apply_app_scope('AppBuildConfig', '"appId"');
SELECT apply_app_scope('Build', '"appId"');
-- Nullable-appId tables (Job, AuditEvent, AsoAlarm) are intentionally left at
-- tenant-only scope: their app-less rows are workspace-wide, and the helper's
-- NULL allowance would make per-app filtering leaky/confusing there.

-- NOTE: TenantMember is deliberately NOT isolated here. It is the table the
-- request pipeline reads to RESOLVE the active tenant (membership lookup
-- happens before any tenant GUC exists), so it is queried via the
-- bypass/admin client during auth bootstrap. The scoped paths that touch it
-- (members management routes) always carry an explicit tenantId predicate.

-- ────────────────────────────────────────────────────────────────────────
-- Migration / admin role with BYPASSRLS
-- (created idempotently; password set externally via secret manager)
-- ────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gp_migration_admin') THEN
    CREATE ROLE gp_migration_admin BYPASSRLS NOINHERIT;
  END IF;
END $$;

GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO gp_migration_admin;
GRANT ALL PRIVILEGES ON ALL SEQUENCES IN SCHEMA public TO gp_migration_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON TABLES TO gp_migration_admin;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT ALL PRIVILEGES ON SEQUENCES TO gp_migration_admin;

-- ────────────────────────────────────────────────────────────────────────
-- Application role — NON-superuser, NON-bypassrls (created idempotently).
--
-- The web app and worker MUST connect as this role (DATABASE_URL), NOT as a
-- superuser. Postgres superusers AND roles with BYPASSRLS ignore Row-Level
-- Security entirely, so connecting as the bootstrap superuser (`gp`) silently
-- disables every policy above. This role is subject to RLS: it can only see
-- rows whose tenantId matches the `app.current_tenant` GUC.
--
-- Cross-tenant/admin work (auth bootstrap, migrations, billing reconciliation)
-- uses the separate `gp_migration_admin` BYPASSRLS role via DATABASE_URL_ADMIN.
--
-- The password is intentionally NOT set here — set it out-of-band, e.g.
--   ALTER ROLE gp_app WITH PASSWORD '...';   (secret manager / init script)
-- and point DATABASE_URL at gp_app. See @marquee/db assertDbRoleRespectsRls(),
-- which refuses to boot in production if the connected role bypasses RLS.
-- ────────────────────────────────────────────────────────────────────────

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'gp_app') THEN
    CREATE ROLE gp_app LOGIN NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  ELSE
    -- Enforce the security-critical attributes even if the role pre-exists.
    ALTER ROLE gp_app NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;
  END IF;
END $$;

GRANT USAGE ON SCHEMA public TO gp_app;
GRANT SELECT, INSERT, UPDATE, DELETE ON ALL TABLES IN SCHEMA public TO gp_app;
GRANT USAGE, SELECT ON ALL SEQUENCES IN SCHEMA public TO gp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT SELECT, INSERT, UPDATE, DELETE ON TABLES TO gp_app;
ALTER DEFAULT PRIVILEGES IN SCHEMA public
  GRANT USAGE, SELECT ON SEQUENCES TO gp_app;

-- ────────────────────────────────────────────────────────────────────────
-- Append-only audit trail
-- ────────────────────────────────────────────────────────────────────────
-- The audit log is the forensic record of member/credential/ownership changes.
-- The app role may only INSERT and SELECT it — never UPDATE or DELETE — so a
-- bug (or a future SQL-injection primitive) running in a tenant's scoped context
-- cannot silently rewrite or wipe history. Retention pruning uses the BYPASSRLS
-- admin role. Re-applied idempotently after the blanket GRANT above.
REVOKE UPDATE, DELETE ON "AuditEvent" FROM gp_app;
