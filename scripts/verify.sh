#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/.."
green="\033[32m"; red="\033[31m"; yellow="\033[33m"; reset="\033[0m"
pass=0; fail=0
check() { local label="$1"; shift; if "$@" > /dev/null 2>&1; then printf "  ${green}✓${reset} %s\n" "$label"; pass=$((pass+1)); else printf "  ${red}✗${reset} %s\n" "$label"; fail=$((fail+1)); fi; }

echo ""; echo "━━━ Root ━━━"
check "package.json"           test -f package.json
check "pnpm-workspace.yaml"    test -f pnpm-workspace.yaml
check "turbo.json"             test -f turbo.json
check ".env.example"           test -f .env.example
check "docker-compose.yml"     test -f docker-compose.yml
check "CI workflow"            test -f .github/workflows/pr.yml

echo ""; echo "━━━ Packages ━━━"
for pkg in db core secrets cache api-contracts ui storage jobs email; do
  check "packages/$pkg"        test -f "packages/$pkg/package.json"
done

echo ""; echo "━━━ Foundation ━━━"
check "Prisma schema"          test -f packages/db/prisma/schema.prisma
check "RLS migration"          test -f packages/db/prisma/migrations/20260517_0001_enable_rls/migration.sql
check "tenantContext"          test -f packages/db/src/tenantContext.ts
check "Audit helper"           test -f packages/db/src/audit.ts
check "CSRF middleware"        test -f apps/web/src/lib/csrf.ts
check "Idempotency"            test -f apps/web/src/lib/idempotency.ts
check "Rate limit"             test -f apps/web/src/lib/rateLimitWrap.ts
check "API client"             test -f apps/web/src/lib/apiClient.ts

echo ""; echo "━━━ Adapters ━━━"
check "AppleApps"              test -f packages/core/src/adapters/apple/AppleApps.ts
check "AppleMetadata"          test -f packages/core/src/adapters/apple/AppleMetadata.ts
check "AppleScreenshots"       test -f packages/core/src/adapters/apple/AppleScreenshots.ts
check "AppleBuilds"            test -f packages/core/src/adapters/apple/AppleBuilds.ts
check "GoogleEditSession"      test -f packages/core/src/adapters/google/GoogleEditSession.ts
check "GoogleListings"         test -f packages/core/src/adapters/google/GoogleListings.ts
check "GoogleImages"           test -f packages/core/src/adapters/google/GoogleImages.ts
check "GoogleAab"              test -f packages/core/src/adapters/google/GoogleAab.ts
check "GoogleTracks"           test -f packages/core/src/adapters/google/GoogleTracks.ts
check "Master JSON importer"   test -f packages/core/src/orchestrators/masterJson.ts
check "Adapters factory"       test -f apps/web/src/lib/adapters.ts

echo ""; echo "━━━ API: metadata / screenshots / previews ━━━"
check "Apps GET/POST"          test -f apps/web/src/app/api/v1/apps/route.ts
check "Apps discover"          test -f apps/web/src/app/api/v1/apps/discover/route.ts
check "App by id"              test -f "apps/web/src/app/api/v1/apps/[id]/route.ts"
check "Metadata GET"           test -f "apps/web/src/app/api/v1/apps/[id]/metadata/route.ts"
check "Metadata locale PATCH"  test -f "apps/web/src/app/api/v1/apps/[id]/metadata/[locale]/route.ts"
check "Metadata fetch"         test -f "apps/web/src/app/api/v1/apps/[id]/metadata/fetch/route.ts"
check "Metadata push"          test -f "apps/web/src/app/api/v1/apps/[id]/metadata/push/route.ts"
check "Master JSON import"     test -f "apps/web/src/app/api/v1/apps/[id]/metadata/import-master-json/route.ts"
check "Master JSON export"     test -f "apps/web/src/app/api/v1/apps/[id]/metadata/export-master-json/route.ts"
check "Diff endpoint"          test -f "apps/web/src/app/api/v1/apps/[id]/metadata/diff/route.ts"
check "Screenshot list"        test -f "apps/web/src/app/api/v1/apps/[id]/screenshots/route.ts"
check "Screenshot upload"      test -f "apps/web/src/app/api/v1/apps/[id]/screenshots/upload/route.ts"
check "Screenshot scId"        test -f "apps/web/src/app/api/v1/apps/[id]/screenshots/[scId]/route.ts"
check "Screenshot reorder"     test -f "apps/web/src/app/api/v1/apps/[id]/screenshots/reorder/route.ts"
check "Screenshot fetch"       test -f "apps/web/src/app/api/v1/apps/[id]/screenshots/fetch/route.ts"
check "Bulk import ZIP"        test -f "apps/web/src/app/api/v1/apps/[id]/screenshots/bulk-import-zip/route.ts"
check "Apply to locales"       test -f "apps/web/src/app/api/v1/apps/[id]/screenshots/apply-to-locales/route.ts"
check "Previews list"          test -f "apps/web/src/app/api/v1/apps/[id]/previews/route.ts"
check "Previews upload"        test -f "apps/web/src/app/api/v1/apps/[id]/previews/upload/route.ts"
check "Previews delete"        test -f "apps/web/src/app/api/v1/apps/[id]/previews/[pvId]/route.ts"
check "Previews fetch"         test -f "apps/web/src/app/api/v1/apps/[id]/previews/fetch/route.ts"

echo ""; echo "━━━ API: builds + submission + audit + jobs ━━━"
check "Builds list"            test -f "apps/web/src/app/api/v1/apps/[id]/builds/route.ts"
check "AAB upload"             test -f "apps/web/src/app/api/v1/apps/[id]/builds/upload/route.ts"
check "Track assign"           test -f "apps/web/src/app/api/v1/apps/[id]/tracks/[trackName]/route.ts"
check "Submit for review"      test -f "apps/web/src/app/api/v1/apps/[id]/submit-for-review/route.ts"
check "Audit list"             test -f apps/web/src/app/api/v1/audit/route.ts
check "Jobs SSE"               test -f "apps/web/src/app/api/v1/jobs/[id]/stream/route.ts"

echo ""; echo "━━━ API: members + invitations ━━━"
check "Invitations list/create" test -f "apps/web/src/app/api/v1/t/[tenantSlug]/invitations/route.ts"
check "Invitation revoke"       test -f "apps/web/src/app/api/v1/t/[tenantSlug]/invitations/[id]/route.ts"
check "Invitation accept"       test -f apps/web/src/app/api/v1/invitations/accept/route.ts
check "Member role / remove"    test -f "apps/web/src/app/api/v1/t/[tenantSlug]/members/[userId]/route.ts"

echo ""; echo "━━━ Worker ━━━"
check "Worker entrypoint"      test -f apps/worker/src/index.ts
check "Worker processors"      test -f apps/worker/src/processors.ts

echo ""; echo "━━━ UI: metadata + screenshots + previews ━━━"
check "Connect Wizard"         test -f apps/web/src/components/apps/ConnectAppWizard.tsx
check "Metadata editor"        test -f apps/web/src/components/metadata/MetadataEditor.tsx
check "Push preview sheet"     test -f apps/web/src/components/metadata/PushPreviewSheet.tsx
check "Master JSON sheet"      test -f apps/web/src/components/metadata/ImportMasterJsonSheet.tsx
check "Add credential sheet"   test -f apps/web/src/components/credentials/AddCredentialSheet.tsx
check "ScreenshotsPanel"       test -f apps/web/src/components/screenshots/ScreenshotsPanel.tsx
check "ScreenshotsSortable"    test -f apps/web/src/components/screenshots/SortableGrid.tsx
check "ApplyToLocalesSheet"    test -f apps/web/src/components/screenshots/ApplyToLocalesSheet.tsx
check "BulkImportSheet"        test -f apps/web/src/components/screenshots/BulkImportSheet.tsx
check "PreviewsPanel"          test -f apps/web/src/components/previews/PreviewsPanel.tsx
check "VideoUploadDialog"      test -f apps/web/src/components/previews/VideoUploadDialog.tsx
check "VideoLightbox"          test -f apps/web/src/components/previews/VideoLightbox.tsx

echo ""; echo "━━━ UI: builds + submission + audit + team ━━━"
check "Builds page"            test -f "apps/web/src/app/(dashboard)/t/[tenantSlug]/apps/[appId]/builds/page.tsx"
check "Submission page"        test -f "apps/web/src/app/(dashboard)/t/[tenantSlug]/apps/[appId]/submission/page.tsx"
check "BuildsPanel"            test -f apps/web/src/components/builds/BuildsPanel.tsx
check "AabUploadDialog"        test -f apps/web/src/components/builds/AabUploadDialog.tsx
check "TrackAssignDialog"      test -f apps/web/src/components/builds/TrackAssignDialog.tsx
check "SubmissionPanel"        test -f apps/web/src/components/builds/SubmissionPanel.tsx
check "Audit page"             test -f "apps/web/src/app/(dashboard)/t/[tenantSlug]/audit/page.tsx"
check "Team page"              test -f "apps/web/src/app/(dashboard)/t/[tenantSlug]/team/page.tsx"
check "InviteMemberSheet"      test -f apps/web/src/components/team/InviteMemberSheet.tsx
check "MemberRow"              test -f apps/web/src/components/team/MemberRow.tsx
check "InvitationRow"          test -f apps/web/src/components/team/InvitationRow.tsx
check "Accept invite page"     test -f "apps/web/src/app/(auth)/accept-invite/[token]/page.tsx"

echo ""; echo "━━━ Shell + polish ━━━"
check "Topbar"                 test -f apps/web/src/components/shell/Topbar.tsx
check "Sidebar"                test -f apps/web/src/components/shell/Sidebar.tsx
check "TenantShell"            test -f apps/web/src/components/shell/TenantShell.tsx
check "PageHeader"             test -f apps/web/src/components/shell/PageHeader.tsx
check "ThemeSwitcher"          test -f apps/web/src/components/shell/ThemeSwitcher.tsx
check "CommandPalette"         test -f apps/web/src/components/shell/CommandPalette.tsx
check "Toaster"                test -f apps/web/src/components/feedback/Toaster.tsx
check "Sheet primitive"        test -f apps/web/src/components/feedback/Sheet.tsx
check "Root error boundary"    test -f apps/web/src/app/error.tsx
check "App detail err. bnd."   test -f "apps/web/src/app/(dashboard)/t/[tenantSlug]/apps/[appId]/error.tsx"
check "Settings page"          test -f "apps/web/src/app/(dashboard)/t/[tenantSlug]/settings/page.tsx"

echo ""; echo "━━━ Email package ━━━"
check "Transport interface"    test -f packages/email/src/Transport.ts
check "Console transport"      test -f packages/email/src/ConsoleTransport.ts
check "SMTP transport"         test -f packages/email/src/SmtpTransport.ts
check "Invitation template"    test -f packages/email/src/templates/invitation.ts
check "Welcome template"       test -f packages/email/src/templates/welcome.ts

echo ""; echo "━━━ Tests — Unit & Locale ━━━"
check "Locale Google"          test -f packages/core/src/locale/__tests__/google.test.ts
check "Locale Apple"           test -f packages/core/src/locale/__tests__/apple.test.ts
check "Locale roundtrip"       test -f packages/core/src/locale/__tests__/roundtrip.test.ts
check "Apple JWT"              test -f packages/core/src/crypto/__tests__/apple-jwt.test.ts
check "Google JWT"             test -f packages/core/src/crypto/__tests__/google-jwt.test.ts
check "Screenshot spec"        test -f packages/core/src/validation/__tests__/screenshotSpecs.test.ts
check "Android spec"           test -f packages/core/src/validation/__tests__/androidImageSpecs.test.ts
check "Video magic"            test -f packages/core/src/validation/__tests__/videoMagicBytes.test.ts
check "Master JSON"            test -f packages/core/src/orchestrators/__tests__/masterJson.test.ts
check "SecretProvider"         test -f packages/secrets/src/__tests__/FilesystemSecretProvider.test.ts
check "Storage keys"           test -f packages/storage/src/__tests__/keys.test.ts

echo ""; echo "━━━ Tests — Integration (DB / lib) ━━━"
check "RLS integration"        test -f packages/db/src/__tests__/rls.test.ts
check "RLS deep coverage"      test -f packages/db/src/__tests__/rls-deep.test.ts
check "Metrics"                test -f packages/observability/src/__tests__/metrics.test.ts
check "Web vitest config"      test -f apps/web/vitest.config.ts
check "CSRF lib test"          test -f apps/web/src/lib/__tests__/csrf.test.ts
check "Idempotency lib test"   test -f apps/web/src/lib/__tests__/idempotency.test.ts
check "Rate-limit lib test"    test -f apps/web/src/lib/__tests__/rateLimitWrap.test.ts
check "Responses lib test"     test -f apps/web/src/lib/__tests__/responses.test.ts
check "Observe lib test"       test -f apps/web/src/lib/__tests__/observe.test.ts

echo ""; echo "━━━ Tests — E2E (Playwright) ━━━"
check "Playwright config"      test -f e2e/playwright.config.ts
check "Cross-tenant E2E"       test -f e2e/tests/cross-tenant-isolation.spec.ts
check "Auth E2E"               test -f e2e/tests/auth.spec.ts
check "Public endpoints E2E"   test -f e2e/tests/public-endpoints.spec.ts
check "CSRF+rate-limit E2E"    test -f e2e/tests/csrf-and-ratelimit.spec.ts
check "Dashboard nav E2E"      test -f e2e/tests/dashboard-navigation.spec.ts
check "Credentials flow E2E"   test -f e2e/tests/credentials-flow.spec.ts
check "Apps list E2E"          test -f e2e/tests/apps-list.spec.ts

echo ""; echo "━━━ Tests — Load (k6) ━━━"
check "Load README"            test -f tests/load/README.md
check "Baseline soak"          test -f tests/load/baseline.js
check "Public probes burst"    test -f tests/load/public-probes.js
check "Auth burst"             test -f tests/load/auth-burst.js
check "Push fairness"          test -f tests/load/push-fairness.js

echo ""; echo "━━━ Tests — Chaos drills ━━━"
check "Chaos README"           test -f tests/chaos/README.md
check "Chaos lib.sh"           test -f tests/chaos/lib.sh
check "Drill: redis flap"      test -x tests/chaos/redis-flap.sh
check "Drill: postgres kill"   test -x tests/chaos/postgres-kill.sh
check "Drill: storage offline" test -x tests/chaos/storage-offline.sh
check "Drill: worker down"     test -x tests/chaos/worker-down.sh
check "Drill: RLS probe"       test -x tests/chaos/rls-violation-probe.sh
check "Drill: tenant-ctx miss" test -x tests/chaos/tenant-context-missing.sh
check "Drill: run-all"         test -x tests/chaos/run-all.sh

echo ""; echo "━━━ Stability — Observability ━━━"
check "packages/observability" test -f packages/observability/package.json
check "Metrics registry"       test -f packages/observability/src/metrics.ts
check "Observability helpers"  test -f packages/observability/src/helpers.ts
check "SLO targets"            test -f packages/observability/src/slo.ts
check "Web observe wrapper"    test -f apps/web/src/lib/observe.ts
check "/metrics route"         test -f apps/web/src/app/api/v1/metrics/route.ts
check "/health/deep route"     test -f apps/web/src/app/api/v1/health/deep/route.ts
check "/status JSON route"     test -f apps/web/src/app/api/v1/status/route.ts
check "/status page"           test -f apps/web/src/app/status/page.tsx

echo ""; echo "━━━ Stability — Runbooks ━━━"
for r in README api-down high-error-rate slow-database redis-down disk-full \
         apple-integration-fail google-integration-fail worker-stalled \
         rls-violation database-restore backup-failure \
         credential-leak-suspected deploy-rollback; do
  check "runbook: ${r}"        test -f "docs/runbook/${r}.md"
done

echo ""; echo "━━━ Stability — Operations ━━━"
check "backup-pg.sh"           test -x scripts/backup-pg.sh
check "restore-pg.sh"          test -x scripts/restore-pg.sh
check "synthetic canary"       test -x scripts/synthetic-canary.sh

echo ""; echo "━━━ Stability — Secret scanning + hooks ━━━"
check ".gitleaks.toml"         test -f .gitleaks.toml
check ".husky pre-commit"      test -x .husky/pre-commit
check ".lintstagedrc.json"     test -f .lintstagedrc.json

echo ""; echo "━━━ Docs ━━━"
for n in 01_ARCHITECTURE 02_BACKEND_API_SPEC 03_DATA_MODEL 04_APPLE_INTEGRATION 05_GOOGLE_INTEGRATION 06_FRONTEND_UI_UX 07_SECURITY 08_ROADMAP 09_TECH_STACK 10_MULTI_TENANT 11_SELF_HOST_TO_SAAS 12_DESIGN_SYSTEM 13_STABILITY_OPS 14_QA_TESTING; do
  check "docs/${n}.md"         test -f "docs/${n}.md"
done

echo ""
echo "━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━━"
printf "  ${green}${pass} passed${reset}"
if [[ $fail -gt 0 ]]; then printf "  ${red}${fail} failed${reset}\n"; exit 1; fi
echo ""
echo ""
echo "  Next: ${yellow}./scripts/setup.sh${reset} → ${yellow}pnpm dev${reset} (+ ${yellow}pnpm --filter @marquee/worker dev${reset})"
echo ""
