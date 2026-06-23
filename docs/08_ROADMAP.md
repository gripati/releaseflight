# 08 — Roadmap (Multi-Tenant V1 → SaaS V2)

Multi-tenant **birinci günden**. Self-host first, SaaS-ready. Tek geliştirici (sen) baz alındı; tüm tahminler buna göre kalibrelendi. Tahminler **muhafazakar** — Apple/Google integration edge case'leri ve operational disiplinler her zaman beklenenden uzun sürer.

## 0. Faz Genel Görünümü

```
Phase 0 — Setup                                (1 hafta)
Phase 1 — Foundation + Multi-Tenant Core      (4 hafta)
Phase 2 — Metadata MVP                         (3 hafta)
Phase 3 — Screenshots                          (2 hafta)
Phase 4 — App Previews                         (1 hafta)
Phase 5 — Polish + Self-Host V1.0 Beta         (2 hafta)
                                                ────────
                                                13 hafta = ~3.5 ay → V1.0 (Self-Host MT)

Phase 6 — Multi-User + Invitations + Audit    (2 hafta)
Phase 8 — Stability Hardening (SLO/Runbooks)  (2 hafta)
                                                ────────
                                                +7 hafta → V1.5 (Production-Ready Self-Host)

Phase 9  — SaaS Mode (Signup, Stripe, Marketing) (5 hafta)
Phase 10 — Platform Admin + Status Page         (2 hafta)
Phase 11 — Multi-User Real-Time + Webhooks      (3 hafta)
                                                ────────
                                                +10 hafta → V2.0 (SaaS Public Launch)

Phase 12 — MCP Server + Claude Code Integration (3 hafta) → V2.1
Phase 13 — Enterprise (SSO, Custom Domain, RP)  (4 hafta) → V2.5
```

## 1. Phase 0 — Setup (1 hafta)

**Hedef:** `docker compose up` ile çalışan boş iskelet, CI green.

| Day | Task |
|-----|------|
| 1 | pnpm monorepo + Turborepo + tsconfig base |
| 1 | GitHub Actions (lint + typecheck + boş Vitest) |
| 2 | Next.js 15 boilerplate (`apps/web`) — "hello world" sayfa + fonts (Fraunces, Geist, IBM Plex Mono) |
| 2 | Postgres + Redis + MinIO Docker Compose + healthcheck |
| 3 | Prisma schema (sadece `Tenant`, `User`, `Session`, `TenantMember`) + initial migration |
| 3 | TailwindCSS 4 + design tokens (CSS vars per `12_DESIGN_SYSTEM.md`) |
| 4 | Pino logger + structured middleware + log redaction patterns |
| 4 | Vitest + Playwright + msw setup; testcontainers-postgres helper |
| 5 | Dockerfile multi-stage (web + worker) + docker-compose.dev + docker-compose.test |
| 5 | nginx + dev TLS (mkcert) + Caddy alternative |
| 6 | `.skills/` referans klasörü + ana README skill notları |
| 6 | ADR-001 / ADR-002 yazılır |
| 7 | Smoke: full stack up → boş Next.js + boş `/api/v1/healthz` 200 OK |

**Kabul:**
- [ ] `pnpm install && pnpm dev` tek komutla başlar
- [ ] `docker compose up` tüm servisler ayağa kalkar
- [ ] CI green
- [ ] `https://localhost` erişilir, Fraunces font yükleniyor
- [ ] Yeni geliştirici 30 dakikada onboard (README test edildi)

## 2. Phase 1 — Foundation + Multi-Tenant Core (4 hafta)

### Week 1 — Auth + Multi-Tenant Schema

| Day | Task |
|-----|------|
| 1-2 | Better-Auth setup + email/password (Argon2id) + session cookie + CSRF |
| 2 | Tenant + TenantMember + Invitation Prisma modeller + migration |
| 3 | RLS migration (Postgres `ALTER TABLE ENABLE ROW LEVEL SECURITY` + policies) |
| 3 | `tenantContext` AsyncLocalStorage + Prisma middleware (SET LOCAL) |
| 4 | `withTenantContext` route wrapper + middleware (header injection) |
| 4 | `seedSelfHost.ts` — default tenant + owner user auto-create |
| 5 | Login + Logout endpoint + `/login` page (UI per `06_FRONTEND_UI_UX.md` 6.2) |

### Week 2 — RBAC + Cross-Tenant Test Suite

| Day | Task |
|-----|------|
| 1 | RBAC middleware (`requireRole`) + 4 role enforcement |
| 2 | Rate limit (Redis sliding window) + per-tenant/user/IP/action |
| 2 | Idempotency cache middleware (24h) |
| 3-4 | **RLS integration test suite** — Tenant A cannot read/write/update/delete Tenant B's data (10+ test) |
| 5 | **E2E tenant isolation suite** — Playwright per `14_QA_TESTING.md` 14.5 |

### Week 3 — Credential Management + Secret Provider

| Day | Task |
|-----|------|
| 1 | `SecretProvider` interface + Filesystem implementation (`~/.marquee/secrets/tenants/<id>/`) |
| 1 | Unit test (put/get/delete round-trip) + file permission test (mode 600) |
| 2 | Credential model + CRUD endpoint (`/api/v1/t/:slug/credentials/*`) |
| 2 | UI: `/t/[slug]/credentials` list + add modal (per UI/UX 6.16) |
| 3 | `AppleAuth.testConnection` + JWT ES256 generator (`node:crypto`) |
| 3 | `GoogleAuth.testConnection` + OAuth2 token flow (RS256) |
| 4 | UI: drop .p8 / drop service JSON + parse + validate + test + save |
| 5 | LogRedactor + Pino redact patterns + log leak test (grep CI) |

### Week 4 — Apple + Google Adapter Foundations

| Day | Task |
|-----|------|
| 1 | `AppleClient` HTTP wrapper + paginate iterator + token cache (Redis) |
| 1 | `GoogleClient` HTTP wrapper + token cache |
| 2 | `AppleApps.listApps` + `getFullDetails` (sandbox app ile gerçek test) |
| 2 | `GoogleEditSession.open/discard/commit` + smart commit pipeline (4 strateji) |
| 3 | `LocaleConverter` (Apple + Google maps, 77+ Google Play locales) |
| 3 | Locale unit tests (35+ test case) + edge cases (he, iw-IL, zh-Hans/CN) |
| 5 | Tenant + Credential E2E (login → add Apple cred → test connection → green) |

**Phase 1 Kabul:**
- [ ] Lokal'de login + 2 tenant (default + test) + 2 user (owner + editor)
- [ ] Cross-tenant RLS test suite full green
- [ ] Cross-tenant E2E test (2 browser tab, 2 farklı tenant — visibility 0)
- [ ] Apple + Google credential add + test connection green
- [ ] Log redaction grep test pass (no `private_key` literal in logs)
- [ ] CI < 8 dakika

## 3. Phase 2 — Metadata MVP (3 hafta)

### Week 1 — App Management

| Day | Task |
|-----|------|
| 1 | `App` Prisma model (tenantId composite unique) + Repo |
| 2 | `POST /apps/discover` (Apple) — sandbox app listele |
| 2 | UI: Connect App wizard (3 step Sheet per 6.6) |
| 3 | `App` CRUD endpoint + RBAC |
| 4 | UI: `/t/[slug]/apps` list page + cards (per 6.5) |
| 5 | App detail shell + tab navigation (`/apps/[id]/overview` per 6.7) |

### Week 2 — Apple Metadata Pull/Push

| Day | Task |
|-----|------|
| 1 | `AppleMetadata.fetchAppInfoLocalizations` (paginated, pageLimit 50) |
| 1 | `AppleMetadata.fetchVersionLocalizations` (aynı) |
| 2 | `mergeLocalizations` helper + unit test (locale yalnız birinde edge case) |
| 2 | `metadata.fetch` BullMQ job + worker + SSE progress + DB UPSERT |
| 3 | `AppleMetadata.upsertLocalization` (8 alt-akış: create/update for both AppInfo + Version) |
| 3 | 409 graceful skip (state locked field) |
| 4 | `AppleMetadata.updateVersionSettings` (versionString, releaseType, copyright) |
| 4 | `metadata.push` single-locale job + sandbox app push e2e |
| 5 | MetadataPage UI (per 6.8) — LocaleRail + Editor + CharLimitBar |

### Week 3 — Google Metadata + Master JSON + Diff UX

| Day | Task |
|-----|------|
| 1 | `GoogleListings.fetchAllListings` (withEditReadOnly) |
| 2 | `GoogleListings.upsertListing` + `pushAllListings` (smart commit) |
| 3 | `metadata.push.bulk` job + per-locale progress + summary result |
| 4 | `MasterJsonImporter` (parse, locale normalize, validate, UPSERT) |
| 4 | UI: Import modal (per 6.9) + dry-run + truncate preview |
| 5 | **DiffSheet** UI (per 6.8 + 12.7.8) — word-level diff + unsupported warning + confirm |
| 5 | E2E: import master JSON → preview diff → confirm push → live on sandbox |

**Phase 2 Kabul:**
- [ ] iOS sandbox app metadata pull (35 locale) + UI'da render
- [ ] Tek locale edit + save locally (dirty=true) + push → mağazada güncel
- [ ] Tüm locale push (`metadata.push.bulk`) + 32+/35 success
- [ ] Android sandbox app metadata push (smart commit'in 4 stratejisi test edildi)
- [ ] Master JSON 35 locale import + validate + push end-to-end
- [ ] Diff preview UX hatasız (cancel, confirm both yollarda)
- [ ] Dirty bit doğru çalışır (fetch dirty olanı sessizce ezmiyor — 409 DIRTY_OVERWRITE_BLOCKED)
- [ ] Cross-tenant: Tenant B'nin app'inin metadata'sını pull/push imkansız

## 4. Phase 3 — Screenshots (2 hafta)

### Week 1 — Apple Screenshots (3-Step Upload)

| Day | Task |
|-----|------|
| 1 | `AppleScreenshots.fetchAllScreenshots` (hierarchical 4-level pagination) |
| 2 | iOS spec port (`IOS_SCREENSHOT_SPECS`, 13 device types) + validation |
| 2 | Sync upload endpoint (multipart, sharp dimension validate, 8MB limit) |
| 3 | Reserve POST → uploadOperations parse |
| 3 | PUT chunks to S3 (Content-Type header from response, stream) |
| 4 | PATCH commit + MD5 (`node:crypto`) + state polling |
| 4 | `screenshot.upload` job + chunk progress SSE + orphan cleanup |
| 5 | ScreenshotGrid UI (dnd-kit, per 6.10) + ordinal bulk PATCH |

### Week 2 — Android Images + Polish

| Day | Task |
|-----|------|
| 1 | `GoogleImages.fetchAllImages` (per language, all image types) |
| 2 | `GoogleImages.uploadImage` (raw multipart, www.googleapis.com host) |
| 2 | Icon + featureGraphic (single-asset constraints, exact dimensions) |
| 3 | Backend image proxy + thumbnail (sharp → webp) cache |
| 3 | Storage isolation `tenants/<id>/apps/<id>/screenshots/...` |
| 4 | Bulk import (ZIP, server-side unzip) + validation report |
| 4 | "Apply to other locales" feature (job spawn per locale) |
| 5 | Lightbox + drag-drop reorder polish + delete confirm |

**Phase 3 Kabul:**
- [ ] iOS APP_IPHONE_65 10 screenshot upload + reorder + delete e2e
- [ ] Android phoneScreenshots 8 image + icon (512×512) + featureGraphic (1024×500)
- [ ] Bulk ZIP import 50+ file
- [ ] Validation: 9MB reject + invalid dimensions reject
- [ ] Thumbnail cache (lighthouse: repeated load < 100ms)
- [ ] "Apply to other 34 locales" tek tıkla
- [ ] Cross-tenant: Tenant A Tenant B'nin screenshot'unu silemez

## 5. Phase 4 — App Previews (1 hafta)

| Day | Task |
|-----|------|
| 1 | `AppleAppPreviews.fetchAllPreviews` (parallel to screenshots) |
| 1 | iOS preview specs + `screenshotToPreviewType` helper (`APP_` strip) |
| 2 | Video validation (magic byte sniff `ftyp` + format check) |
| 2 | `AppleAppPreviews.uploadPreview` (AbstractAssetUploader reuse) |
| 3 | UI: Preview grid + poster + lightbox video player (per 6.11) |
| 4 | `preview.upload` job + MB progress + 500MB limit |
| 5 | E2E: 100MB+ video upload sandbox |

**Phase 4 Kabul:**
- [ ] iPhone 6.5" 3 preview upload + reorder + delete
- [ ] 200MB video upload smooth, donmadan
- [ ] previewType naming kontrol (APP_ yok)

## 6. Phase 5 — Polish + V1.0 Self-Host Beta (2 hafta)

### Week 1 — UX Polish + Test Coverage

| Day | Task |
|-----|------|
| 1 | Empty states (Dashboard "Edition Zero", Apps, Credentials per 6.4-6.16) |
| 1 | Loading skeletons + page-load orchestration (editorial-reveal animation) |
| 2 | Error boundaries per route + `/error` editorial design |
| 2 | Toast system (Sonner styled) + 4 variant + actionable toasts |
| 3 | Audit log endpoint + UI (per 6.15) + filter/search |
| 3 | Settings sayfası (Profile + Tenant + Preferences) |
| 4 | Keyboard shortcuts + cmdk CommandPalette + theme switcher (radial reveal) |
| 5 | A11y: axe-core CI green + NVDA spot check |

### Week 2 — Dogfooding + Beta Release

| Day | Task |
|-----|------|
| 1 | Onboarding flow (first-time wizard, 5 step skippable) |
| 2 | Locale character chip showcase (per 12.3.5) |
| 2 | i18n: TR + EN UI dili (next-intl) |
| 3 | Lighthouse audit + perf optimization (FCP < 1.5s) |
| 4 | Internal security pentest (OWASP ZAP automated) |
| 5 | "Eat dog food" — Cyber Clash uygulamasını V1 ile tam yönet 1 gün |
| 6-7 | Bug fix from dogfooding + docs update |

**V1.0 Kabul (MVP):**
- [ ] Unity paketi yerine bu Web App ile Cyber Clash tam yönetilebilir
- [ ] Metadata 35 locale push < 2 dakika
- [ ] Screenshot 142 batch import < 5 dakika
- [ ] Multi-tenant isolation tüm seviyelerde test edilmiş
- [ ] Lighthouse Performance > 90, A11y > 95
- [ ] Cross-tenant E2E test suite full green
- [ ] Bilgi sızıntısı yok (log grep clean)
- [ ] CI < 10 dakika; nightly e2e < 30 dakika
- [ ] Restore drill başarılı (DB + storage + secrets, < 1 saat RTO)
- [ ] V1.0 release tag pushed + CHANGELOG yazıldı

## 7. Phase 6 — Multi-User + Invitations + Audit UI (2 hafta)

### Week 1 — Member Management

| Day | Task |
|-----|------|
| 1 | Invitation model + token generation + email send (Resend/SES) |
| 2 | `/api/v1/t/:slug/invitations` CRUD + revoke |
| 2 | Accept invitation flow (public route, password set if new user) |
| 3 | Team page UI (per 6.19) + role change + remove |
| 4 | Per-user permissions (V2 prep): `allowedAppIds` field, UI hidden |
| 5 | Email templates (React Email): invitation, welcome, password reset |

### Week 2 — Advanced Audit + Real-Time Indicators

| Day | Task |
|-----|------|
| 1-2 | Audit log V2: diff field (before/after, redacted), filterable timeline |
| 3 | App-scoped history (per 6.15) UI + collapsible details |
| 4 | "Sarah is editing this now" presence indicator (V1.5: basic; V2: real-time) |
| 5 | Conflict detection: optimistic save 409 → merge UI |

**V1.1 Kabul:**
- [ ] Invite member by email → accept → join tenant
- [ ] OWNER transfer ownership flow
- [ ] Audit timeline shows diff per change
- [ ] 2 user same tenant: edit notifications


### Week 1 — AAB/IPA Upload

| Day | Task |
|-----|------|
| 1 | `GoogleAabUpload` (retry, 30dk timeout, presigned PUT V1.5+) |
| 2 | UI: Builds tab (per 6.13) + upload modal |
| 3 | iOS IPA: Apple Transporter CLI subprocess (V1.5 only — daemon mode) |
| 4 | Track management (internal/alpha/beta/production assignments) |
| 5 | Build state polling (Apple processingState, Google validation) |


| Day | Task |
|-----|------|
| 3 | Tester groups list + UI |
| 4 | Release notes template + variable replacement |
| 5 | "Upload + auto-distribute" combined flow |

### Week 3 — Review Submission

| Day | Task |
|-----|------|
| 1-2 | `AppleBuilds.submitForReview` (3-step) + pre-flight checklist UI (per 6.14) |
| 3 | Google Play "submit" (track promote with userFraction 1.0) |
| 4 | Submission status tracking + notification when review state changes |
| 5 | E2E: build upload → submit → status update |

**V1.5 Phase 7 Kabul:**
- [ ] IPA upload → TestFlight'a düşer
- [ ] AAB upload + Internal track assignment
- [ ] Submit for review → store UI'da "in review"

## 9. Phase 8 — Stability Hardening (2 hafta) — V1.5 Production-Ready

### Week 1 — Observability + SLO

| Day | Task |
|-----|------|
| 1 | Prometheus metrics integration (per `13_STABILITY_OPS.md` 13.2.1) |
| 2 | Grafana dashboards (7 default boards JSON-provisioned) |
| 3 | Alertmanager rules + Discord webhook (V1) |
| 4 | Status page (Cachet self-host) + automation |
| 5 | OpenTelemetry tracing + Tempo (optional) |

### Week 2 — Runbooks + Chaos + Disaster Recovery

| Day | Task |
|-----|------|
| 1-2 | 16 runbook yaz (per 13.4.2 list) |
| 3 | Backup automation (cron + WAL-G + S3 sync) |
| 3 | Restore drill — staging tam restore başarılı |
| 4 | Chaos game day 1 (per 13.9.1) — kill workers, latency injection, find bugs, fix |
| 4 | Load test baseline (k6) — 100 user × 5 dakika |
| 5 | External security pentest schedule + clean HIGH findings |
| 5 | Status page live + first incident drill (synthetic outage) |

**V1.5 Release Kabul:**
- [ ] SLO dashboard yaşıyor (Grafana erişilir)
- [ ] 16 runbook + on-call training notes
- [ ] Backup günlük + 1 başarılı restore drill
- [ ] Alerting end-to-end test (test alert ulaştı)
- [ ] 24 saat soak test (sürekli yük, memory leak yok)
- [ ] Chaos game day completed + lessons documented
- [ ] Load test SLO geçti
- [ ] Pentest clean
- [ ] Documentation tier full (architecture, runbook, ADR'ler dolu)
- [ ] V1.5 release tag + CHANGELOG + upgrade guide

## 10. Phase 9 — SaaS Mode (5 hafta)

### Week 1 — Signup + Tenant Provisioning

| Day | Task |
|-----|------|
| 1 | `DEPLOY_MODE` env config + boot validation |
| 1 | `/api/v1/auth/signup` endpoint (per `11_SELF_HOST_TO_SAAS.md` 11.3) |
| 2 | Email verification flow + Resend integration + templates |
| 3 | UI: `/signup` page + tenant slug uniqueness check + captcha (hCaptcha) |
| 4 | Onboarding wizard (per 11.6) — 5 step |
| 5 | E2E signup → verify → onboarding → first push |

### Week 2 — Marketing Pages

| Day | Task |
|-----|------|
| 1-2 | Landing page (`/`) — hero, features, social proof |
| 3 | `/pricing` page with plan comparison |
| 4 | `/docs/*` MDX-based docs site |
| 5 | `/changelog` from git tags + manual entries |

### Week 3 — Stripe Billing

| Day | Task |
|-----|------|
| 1 | Stripe customer create on signup |
| 2 | Subscription model + 4 plan tier (Free/Pro/Team/Enterprise) |
| 2 | Stripe webhook handler (per 11.5.2) — subscription updates, payment events |
| 3 | UI: `/settings/billing` (per 6.20) + Stripe Customer Portal link |
| 4 | Plan limit enforcement (apps count, members, monthly pushes) |
| 5 | Usage tracking (UsageRecord aggregate) + trial expiry warning emails |

### Week 4 — Plan Tiers + Self-Service

| Day | Task |
|-----|------|
| 1 | Upgrade flow (Free → Pro → Team) UI |
| 2 | Downgrade + cancellation flow (period-end retention) |
| 3 | Invoice download + history |
| 4 | Limit hit modal ("Upgrade to push more") |
| 5 | Email notifications: payment failed, trial ending, limit reached |

### Week 5 — SaaS Launch Prep

| Day | Task |
|-----|------|
| 1 | Privacy policy + ToS pages (legal counsel review separately) |
| 2 | GDPR DPA template (V2.2 detayı V2.5'te) |
| 3 | hCaptcha account + signup rate limit |
| 4 | Sentry error tracking + RUM |
| 5 | Load test: 1000 concurrent signups simulate |

**V2.0 SaaS Beta Kabul (kapalı beta):**
- [ ] Signup → email verify → onboarding → first push (5 dk içinde tamamlanır)
- [ ] Stripe webhook end-to-end (payment success/fail/sub change)
- [ ] Plan limits enforced
- [ ] Trial ending email sent at -3 days
- [ ] Marketing pages live
- [ ] Privacy / ToS published
- [ ] 50 beta tenant signup pilot

## 11. Phase 10 — Platform Admin + Status Page (2 hafta)

### Week 1 — Platform Admin Panel

| Day | Task |
|-----|------|
| 1 | `PlatformAdmin` model + `BYPASSRLS` connection (audit + tenant admin) |
| 2 | `/admin/dashboard` (MAU, signups, MRR, churn) |
| 3 | `/admin/tenants` list + filter + suspend |
| 4 | `/admin/tenants/[id]` detail (members, apps, usage, billing) |
| 5 | `/admin/audit` cross-tenant + `/admin/feature-flags` per-tenant overrides |

### Week 2 — Status Page Automation + Public Launch

| Day | Task |
|-----|------|
| 1 | Statuspage.io OR Cachet integration |
| 2 | Auto-incident creation from PagerDuty events |
| 3 | Component health auto-update from Prometheus |
| 3 | Maintenance window scheduling + email |
| 4 | Public launch announcement + Product Hunt prep |
| 5 | Press kit + screenshots + demo video |

**V2.0 Public Launch:**
- [ ] All Phase 9 + 10 done
- [ ] Status page live
- [ ] Platform admin tested
- [ ] Onboarding metrics tracking (sign-up → first push funnel)
- [ ] Customer support tool (Plain / Front)
- [ ] Public launch on Product Hunt + IndieHackers + Twitter

## 12. Phase 11 — Multi-User Real-Time + Public API (3 hafta)

### Week 1 — Real-Time Collaboration

| Day | Task |
|-----|------|
| 1 | Y.js / Liveblocks evaluate (per-locale lock pattern) |
| 2-3 | Presence indicator (avatars on edit area) |
| 4-5 | Conflict-free locale edits (CRDT or last-write-wins+notify) |

### Week 2 — Public API + PAT

| Day | Task |
|-----|------|
| 1 | ApiToken model + create UI in Settings |
| 2 | Bearer auth middleware (alternative to session cookie) |
| 3 | OpenAPI 3.1 spec export + Swagger UI public docs |
| 4 | Scoped permissions (apps:read, metadata:push, screenshots:upload) |
| 5 | Rate limit per token + usage analytics |

### Week 3 — Webhooks

| Day | Task |
|-----|------|
| 1 | Webhook subscription model + management UI |
| 2 | Event emission (job.completed, metadata.pushed, build.distributed) |
| 3 | HMAC-SHA256 signature header |
| 4 | Retry queue (exponential backoff) + dead letter |
| 5 | Webhook test endpoint + sample receiver code |

**V2.1 Kabul:**
- [ ] 2 user same locale: presence + conflict detection
- [ ] Public API documented at docs.releaseflight.com
- [ ] Sample PAT script: bash + node SDK
- [ ] Webhooks fire on job complete

## 13. Phase 12 — MCP Server + Claude Code Integration (3 hafta) — V2.1

`anthropics/skills/mcp-builder` skill rehberliğinde:

| Hafta | Konu |
|-------|------|
| 1 | MCP server `@marquee/mcp-server` package — tools: list_apps, get_metadata, push_metadata, upload_screenshot |
| 2 | OAuth flow for Claude Code → connect to user's GP tenant |
| 3 | Documentation + example workflows ("Claude, push latest master JSON for Cyber Clash") |

Çıktı: Game Publisher MCP server, Claude Desktop / Claude Code'a yüklenebilir.

## 14. Phase 13 — Enterprise (4 hafta) — V2.5

| Hafta | Konu |
|-------|------|
| 1 | SAML SSO + SCIM provisioning |
| 2 | Custom domain (CNAME) + wildcard TLS |
| 3 | Database-per-tenant option (dedicated infra add-on) |
| 4 | DPA + SOC 2 prep + EU data residency option |

## 15. Risk Matrisi

| Risk | Olasılık | Etki | Mitigation |
|------|----------|------|-----------|
| Multi-tenant RLS bug → cross-tenant data leak | Düşük | **CRITICAL** | Test suite zorunlu CI gate + chaos test (RLS disable simulation) + audit alerting |
| Apple/Google undocumented edge case | Yüksek | Orta | Sandbox app erken keşif + msw fixture'lar; Sentry alert per upstream error type |
| Smart commit complexity (4 strategy) bug | Orta | Yüksek | C# kodundan birebir port + per-strategy unit test |
| Bundle upload timeout (200MB+) | Orta | Orta | Presigned PUT V1.5; nginx 30 min timeout; retry queue |
| Secret leak via log | Orta | **CRITICAL** | LogRedactor + pino redact + grep CI check + manual review monthly |
| SaaS launch: Stripe webhook tampering | Düşük | Yüksek | HMAC verify + idempotency + replay protection |
| SaaS abuse: 1000 fake signups | Yüksek (V2) | Orta | hCaptcha + email verify + rate limit per IP |
| Tek geliştirici burnout | Yüksek | Yüksek | Faz kapsamı katı; over-engineering yasak; her 4 haftada bir retrospective |
| Apple API breaking change | Düşük | Yüksek | Apple developer changelog abone + adapter version pin |
| Google Play API deprecation | Düşük | Yüksek | Google Cloud announcement abone |
| Cross-tenant test suite incomplete | Orta | **CRITICAL** | Generator script otomatik tablo başına suite üret |

## 16. Out of Scope (KESİNLİKLE V1-V2'de yok)

- ❌ Mobile native app (V3+)
- ❌ Offline mode
- ❌ AI-generated screenshot/copy (V3 add-on)
- ❌ A/B test management
- ❌ Custom OAuth provider (built-in Google/GitHub enough)
- ❌ Custom report builder (PDF export per app maybe V2.5)
- ❌ Marketplace plugin system
- ❌ Public app marketplace

## 17. Definition of Done (her task için)

- [ ] Code + lint + typecheck pass
- [ ] Unit test yazıldı (yeni logic varsa)
- [ ] Integration test yazıldı (yeni external call varsa, msw fixture ile)
- [ ] **Cross-tenant test yazıldı** (yeni endpoint veya data model varsa) ← CRITICAL
- [ ] OpenAPI/Zod schema güncel
- [ ] RBAC kontrol (yeni endpoint varsa)
- [ ] Audit log yazıldı (yeni mutating action varsa)
- [ ] LogRedactor'dan geçti (yeni log statement varsa)
- [ ] A11y axe-core green
- [ ] Manual happy path test
- [ ] CHANGELOG.md güncel
- [ ] Runbook gerekirse yazıldı/güncellendi
- [ ] PR self-review checklist

## 18. Haftalık Ritm

```
Pazartesi 9:00   Sprint planning + 15 dk pre-flight check (CI health, prod metrics, error budget burn)
Pzt-Cuma         Feature work (~4 saat odaklı blok)
Cuma akşam       PR merge + demo to self + retrospective notes (3 dk)
Cumartesi half   Bug fix backlog / test ekleme / docs update
Pazar            Dinlen — code yazma
```

Her 2 haftada bir retrospective (`docs/retros/YYYY-WW.md`): "Ne iyi gitti? Ne zorladı? Sonraki sprint için ne değişsin?"

## 19. Milestone Takvimi (2026)

```
2026-05-17 (bugün)  Plan finalize ✓
2026-05-24          Phase 0 done — iskelet ayakta
2026-06-21          Phase 1 done — auth + multi-tenant core
2026-07-12          Phase 2 done — metadata MVP
2026-07-26          Phase 3 done — screenshots
2026-08-02          Phase 4 done — app previews
2026-08-16          ★ V1.0 MVP self-host beta release
2026-08-30          Phase 6 done — invitations + audit
2026-10-04          ★ V1.5 self-host production-ready release
2026-11-08          Phase 9 done — SaaS mode + Stripe
2026-11-22          Phase 10 done — platform admin + status
2026-12-13          Phase 11 done — real-time + public API
2026-12-27          ★ V2.0 SaaS public launch
2027-Q1             V2.1 MCP server + Claude Code
2027-Q2             V2.5 Enterprise
```

Bu takvim **aspirational**. Apple/Google integration genelde +50% buffer ister. **Soft milestone, hard quality** prensibi.

## 20. Success Metrics (V1 ve V2)

### V1.0 MVP Success
- 1 kullanıcı (sen) Unity paketini bırakıp Web App'i 1 hafta tam kullanır
- Hiç data kaybı olmadan en az 100 metadata push
- < 5 critical bug raporlanır

### V1.5 Production-Ready Success
- 5+ external user invited as beta self-host
- SLO targets met for 30 days continuous
- Zero security incidents

### V2.0 SaaS Launch Success
- 50 tenant signup ilk ay
- 10 paying customer ($290+ MRR) ilk ay
- < 5% churn ilk 3 ay
- Net Promoter Score (NPS) > 30
- Public launch HN/Product Hunt en az top 10
