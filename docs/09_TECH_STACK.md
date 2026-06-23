# 09 — Tech Stack & Decisions (ADR-Style)

Bu doküman seçilen her teknoloji için **niye seçildiği**, **hangi alternatiflerin elendiği** ve **hangi tetikleyici karar değiştirebileceği** bilgilerini içerir. Architecture Decision Records (ADR) tarzı.

## 9.0 Stack Özeti (Cheat Sheet)

```
┌─────────────────────────────────────────────────────────────────┐
│ Layer            │ Choice                  │ Alternative       │
├──────────────────┼─────────────────────────┼───────────────────┤
│ Language         │ TypeScript 5.6+         │ Go (V2 perf)     │
│ Runtime          │ Node.js 22 LTS          │ Bun, Deno         │
│ Package manager  │ pnpm 9                  │ npm, yarn         │
│ Monorepo         │ Turborepo               │ Nx, Moon          │
│ Frontend         │ Next.js 15 (App Router) │ Remix, Astro      │
│ UI               │ React 19                │ Vue, Svelte       │
│ Styling          │ TailwindCSS 4           │ CSS Modules       │
│ Components       │ shadcn/ui + Radix       │ Mantine, Chakra   │
│ State (server)   │ TanStack Query 5        │ SWR, Apollo       │
│ State (client)   │ Zustand                 │ Redux Toolkit     │
│ Forms            │ React Hook Form + Zod   │ Formik, Final Form│
│ Drag-drop        │ dnd-kit                 │ react-dnd         │
│ Charts           │ Recharts (V1.5+)        │ Visx              │
│ Icons            │ Lucide React            │ Heroicons         │
│ Database         │ PostgreSQL 16           │ SQLite, MySQL     │
│ ORM              │ Prisma 5                │ Drizzle, Kysely   │
│ Queue            │ BullMQ 5 (Redis)        │ pg-boss, Inngest  │
│ Cache            │ Redis 7                 │ KeyDB, Dragonfly  │
│ Object store     │ MinIO (dev) / S3 (prod) │ Cloudflare R2     │
│ Secrets          │ Filesystem + AWS Sec.M. │ Vault, GCP SM     │
│ Auth             │ Better-Auth (V2: NextAuth v5) │ Lucia      │
│ Crypto           │ node:crypto (built-in)  │ jose, jsonwebtoken│
│ HTTP client      │ undici (built-in fetch) │ axios, ky         │
│ Validation       │ Zod 3                   │ Yup, valibot      │
│ Logger           │ pino                    │ winston, bunyan   │
│ Image processing │ sharp                   │ jimp              │
│ Test runner      │ Vitest                  │ Jest              │
│ E2E test         │ Playwright              │ Cypress           │
│ Mock HTTP        │ msw (Mock Service W.)   │ nock              │
│ Linter           │ ESLint 9 + flat config  │ Biome             │
│ Formatter        │ Prettier 3              │ dprint            │
│ CI               │ GitHub Actions          │ GitLab CI         │
│ Container        │ Docker + Compose        │ Podman            │
│ Reverse proxy    │ nginx (prod) / Caddy    │ Traefik           │
│ Observability    │ Pino + Prometheus + Grafana │ OpenTelemetry │
│ TLS              │ Let's Encrypt (cert-manager) │ Cloudflare   │
└──────────────────┴─────────────────────────┴───────────────────┘
```

## 9.1 Dil & Runtime

### ADR-001: TypeScript 5.6+

**Karar:** TypeScript everywhere — backend, frontend, tooling, scripts.

**Niye:**
- Mevcut Unity kodu C# (static typed); TS aynı zihinsel modeli korur, geçişin pürüzü minimal
- Full-stack tek dil → context switch yok
- Frontend (React) için zaten endüstri standardı
- Zod ile **runtime + compile-time** validation aynı tipten türetilir (drift sıfır)
- `noUncheckedIndexedAccess`, `exactOptionalPropertyTypes`, `strict` modlar full açık

**Reddedilen alternatifler:**
- **Go** — Backend için harika (perf, build), ama frontend için yine TS gerekir → 2 dil. V2'de high-throughput SaaS olursa core'u Go'ya yazmak değerlendirilebilir.
- **Rust** — Aynı; overkill, geliştirme hızı düşük.
- **Python** — Dynamic, refactor zor, frontend için yine TS gerek.

**Tetikleyici (revize ederim eğer):** Backend tek başına > 50 req/sec tutarlı yük altında p99 > 500ms olursa.

### ADR-002: Node.js 22 LTS

**Karar:** Node.js 22 LTS (built-in fetch, native test runner var ama kullanmıyoruz).

**Niye:**
- LTS desteği 2027'ye kadar
- Built-in fetch + undici → axios gerekmez
- ESM native + import attributes
- worker_threads, FormData, web streams hepsi built-in

**Reddedilen alternatifler:**
- **Bun** — Hızlı ve cazip ama npm ecosystem'i tam test edilmemiş, native module sorunları olabilir (sharp, prisma). V1.5+ değerlendirilir.
- **Deno** — Permission model güzel ama Next.js ecosystem'i çoğunlukla Node-only.

**Tetikleyici:** Bun 2.0 stable + ecosystem maturity → V2 migration düşünülür.

### ADR-003: pnpm 9 + Turborepo

**Karar:** Workspace yönetimi pnpm, build orchestration Turborepo.

**Niye:**
- pnpm: disk efficient (symlink), strict (peer dep enforce), workspace-native
- Turborepo: incremental build cache, remote cache (Vercel), parallel task execution
- Lock file deterministic

**Reddedilen alternatifler:**
- **npm workspaces** — yavaş, peer dep'lerle hatalı
- **yarn 4** — pnpm ile fonksiyonel eşit ama daha düşük ekosistem momentum
- **Nx** — daha güçlü ama daha karmaşık, bizim ölçek için overkill

## 9.2 Frontend

### ADR-010: Next.js 15 (App Router)

**Karar:** Next.js 15 App Router + React Server Components default.

**Niye:**
- App Router'ın streaming SSR + Suspense + RSC kombinasyonu büyük tablolar için ideal
- File-system based routing — yeni sayfa eklemek kolay
- Built-in API routes (backend ihtiyacımızı karşılar; ek Express gerekmez)
- Image optimization + font optimization built-in
- Vercel ile prod deploy hızlı (V2 opsiyon)
- Turbopack (dev mode hızlı build)

**Reddedilen alternatifler:**
- **Remix** — Harika DX, ama Next.js'in ecosystem ve cache invalidation toolbox'ı daha olgun
- **Astro** — Static-first, dashboard için fit etmez
- **Vite + React** + ayrı backend — daha esnek ama 2 deployment artıyor, sade tut

**Tetikleyici:** Next.js'ten kopuş ihtiyacı (vendor lock-in concerns) → Remix'e migration relatif kolay.

### ADR-011: React 19

**Karar:** React 19.

**Niye:**
- Actions, useOptimistic, useFormStatus → form/upload UX büyük ölçüde sadeleşir
- React Compiler (auto memoization) → performans manuel `useMemo` zorunluluğu olmadan
- Concurrent rendering — büyük tabloların donmaması

**Reddedilen alternatifler:**
- **Vue 3** — Aynı işi yapar ama React ekosistemi 10x daha büyük (shadcn/ui, dnd-kit, vs)
- **Svelte 5** — Hafif ve hızlı; ama component lib çeşitliliği React'in 1/5'i

### ADR-012: TailwindCSS 4 + shadcn/ui + Radix Primitives

**Karar:** Utility-first CSS + accessible primitives.

**Niye:**
- shadcn/ui: copy-paste components → bağımlılık yok, brand isteğine göre rebrand kolay
- Radix Primitives: WCAG out-of-box, keyboard nav, focus management — kendi yazmak 100+ saat
- Tailwind: dark mode (`dark:`), responsive, hızlı prototip
- CSS bundle küçük (PurgeCSS)

**Reddedilen alternatifler:**
- **Mantine** — Component-rich ama theming çok ağır, bundle büyük
- **Chakra UI** — Aynı; ek olarak son zamanlarda momentum kaybı
- **Material UI** — Google look-and-feel; bizim brand'imize uymaz
- **CSS Modules** — Daha sade ama component library üretmek zaman alır

### ADR-013: TanStack Query 5 (server state) + Zustand (client state)

**Karar:** Server data için TanStack Query (cache + invalidation + optimistic), client UI state için Zustand.

**Niye:**
- TanStack Query: fetching + cache + retry + background refetch + optimistic update + infinite query (audit log için) tek paket
- Zustand: küçük, hook-based, no provider hell, devtools var

**Reddedilen alternatifler:**
- **SWR** — TanStack ile fonksiyonel eşit, ama TanStack daha güçlü mutation API + better TS
- **Redux Toolkit** — Server state için TanStack daha iyi; client state için Zustand 10x daha az boilerplate
- **Apollo Client** — REST API kullanıyoruz, GraphQL değil; gereksiz

### ADR-014: React Hook Form + Zod

**Karar:** Formlar için RHF + Zod resolver.

**Niye:**
- Uncontrolled (re-render minimal) → büyük form (metadata editor 11 alan × 35 locale) sorunsuz
- Zod ile **aynı şema** hem frontend hem backend validation → drift sıfır
- `mode: "onChange"` → karakter sayacı anlık
- `useFieldArray` → tester groups, screenshots dinamik liste

**Reddedilen alternatifler:**
- **Formik** — controlled, re-render fazla, performans düşük
- **Final Form** — momentum kaybetti

### ADR-015: dnd-kit

**Karar:** Screenshot grid reorder için dnd-kit (sortable preset).

**Niye:**
- Modern, hook-based, TS-first
- Accessibility built-in (keyboard reorder)
- Touch support (gelecek mobile için)
- React 19 uyumlu

**Reddedilen alternatifler:**
- **react-beautiful-dnd** — abandoned (Atlassian artık maintain etmiyor)
- **react-dnd** — daha eski, daha verbose API

## 9.3 Backend

### ADR-020: Next.js Route Handlers (API)

**Karar:** Ayrı bir Express/Fastify yok — Next.js Route Handlers kullan.

**Niye:**
- Single deployment unit (web + API = tek container)
- Same auth/session/cookie ekosistemi
- Streaming response (SSE için) native
- Type-safe end-to-end (server actions ile)

**Reddedilen alternatifler:**
- **Express** — Daha esnek ama deploy karmaşıklığı artar (2 container)
- **Fastify** — Hızlı ama Next.js'in cache invalidation ile entegrasyonu yok
- **tRPC** — End-to-end type-safe çok cazip; ama OpenAPI export'u istediğimiz için (3rd party integration) REST kalsın. V2'de tRPC + REST iki API yan yana düşünülür.

### ADR-021: Prisma 5 (ORM)

**Karar:** Prisma.

**Niye:**
- Schema-first migration (`prisma migrate dev`)
- Type-safe (generated TS client)
- Studio (`prisma studio`) — admin için ücretsiz UI
- Edge runtime support (Vercel/Cloudflare için V2)

**Reddedilen alternatifler:**
- **Drizzle ORM** — Daha hafif (bundle), SQL-yakın; ama bizim use-case'de Prisma'nın migration tooling'i avantajlı. V2'de bundle size dert olursa Drizzle migration düşünülür.
- **Kysely** — SQL query builder, ORM değil; manuel join'ler için süper ama ben Prisma'nın relation API'sini tercih ediyorum
- **TypeORM** — yavaşladı, decoratorlar zor
- **raw SQL** — yan koy + Kysely escape hatch (Prisma raw query) kullan

**Tetikleyici:** Prisma client size > 10 MB veya cold start > 500ms olursa Drizzle'a geçilebilir.

### ADR-022: PostgreSQL 16

**Karar:** Postgres.

**Niye:**
- JSONB → master JSON metadata için ideal
- FTS (full-text search) → audit search için
- Listen/Notify → opsiyonel pub/sub
- Row-level security → V2 multi-tenant için hazır
- Mature backup tooling (pgBackRest, pg_dump, WAL-G)

**Reddedilen alternatifler:**
- **SQLite** — Single file, "zero ops" cazip ama: backup karmaşık, concurrent write zayıf, BullMQ yok
- **MySQL** — JSONB type yok (sadece JSON), Prisma support daha zayıf
- **MongoDB** — Schemaless cazip ama relational data var (org → app → localization) → çoğunlukla anti-pattern

### ADR-023: BullMQ + Redis

**Karar:** Long-running job için BullMQ (Redis-backed).

**Niye:**
- Mature, üretim-test (Redis 7 streams üzerinde)
- Per-queue concurrency, priority, retry, exponential backoff out-of-box
- UI: Arena, Bull Board (ücretsiz)
- Worker scale: aynı Redis'ten N worker çeker
- Resource: Redis zaten ihtiyacımız var (rate limit, cache)

**Reddedilen alternatifler:**
- **pg-boss** — Postgres-based, Redis gereksiz; bizim yük için yeterli ama BullMQ'nun ecosystem'i daha geniş, monitoring/UI'lar daha olgun
- **Inngest** — SaaS, vendor lock-in
- **Temporal** — overkill, çok kompleks
- **Cron + DB poll** — primitive, debug zor

**Tetikleyici:** Redis bağımlılığı dert olursa (küçük self-host kullanıcısı için) pg-boss + adapter pattern ile değiştirilebilir.

### ADR-024: undici (built-in fetch)

**Karar:** Apple/Google API çağrıları için Node built-in fetch (undici under the hood).

**Niye:**
- Zero dependency
- Stream API native (chunked upload için)
- HTTP/2 support
- AbortSignal native

**Reddedilen alternatifler:**
- **axios** — Eski, interceptor karmaşık, ESM uyumsuzluğu
- **ky** — Hafif wrapper; built-in fetch zaten yeter
- **got** — Aynı; gereksiz ek

**Custom retry/timeout helper'ları kendimiz yazıyoruz (BullMQ'nun retry'sine entegre).**

### ADR-025: Zod 3

**Karar:** Schema + runtime validation = Zod.

**Niye:**
- TypeScript inference (`z.infer<typeof schema>`)
- Compose'able, refine, transform
- zod-to-openapi (OpenAPI schema generation)
- Geniş ecosystem (React Hook Form, tRPC, …)

**Reddedilen alternatifler:**
- **Yup** — JS-first, TS support sonradan eklendi, daha zayıf
- **valibot** — Daha hafif (TS 5.4+ tree-shake friendly); evaluate edilir V1.5

### ADR-026: pino (logger)

**Karar:** Structured JSON logger.

**Niye:**
- Hız (winston'dan ~5x hızlı)
- Built-in redact (sensitive field censoring)
- pino-pretty dev için
- AsyncLocalStorage ile request context auto-inject

**Reddedilen:** winston (yavaş), bunyan (terkedildi)

### ADR-027: sharp (image)

**Karar:** Thumbnail/validation için sharp (libvips bindings).

**Niye:**
- En hızlı Node image lib (jimp'in 10x üstü)
- WebP/AVIF support
- Stream API
- limitInputPixels (decompression bomb koruma)

**Reddedilen:** jimp (pure JS, yavaş), imagemagick (subprocess, güvenlik)

## 9.4 Database & Storage

### ADR-030: MinIO (dev) → S3 (prod)

**Karar:** Object storage abstraction; dev'de MinIO, prod'da S3 (veya MinIO single-node).

**Niye:**
- S3 API standart, MinIO drop-in replacement
- AWS S3 mature, cross-region replication, lifecycle policy, versioning
- Cloudflare R2 (egress free) alternatifi V2

**Reddedilen alternatifler:**
- **Local FS only** — backup karmaşık, multi-server impossible
- **Cloudflare R2** — Cazip (S3 API + free egress) ama V1'de S3-first; provider switch sonra

### ADR-031: Filesystem secret store → AWS Secrets Manager

**Karar:** Dev FS, prod AWS SM. Abstraction layer ile değiştirilebilir.

**Niye:** bkz. `07_SECURITY.md` 7.1.

## 9.5 Auth

### ADR-040: Better-Auth (yeni) veya next-auth v5

**Karar:** V1 için **Better-Auth** (Auth.js v5 alternatifi) — daha az setup, daha esnek session strategy.

**Niye:**
- TypeScript-first (Auth.js v5 daha iyiledi ama Better-Auth daha modern)
- Email/password + OAuth + magic link + WebAuthn ready
- Drizzle/Prisma adapter native

**Alternatif:** next-auth v5 (resmi, daha çok kullanıcı). Eğer Better-Auth ekosistem yetişmezse fallback.

**Reddedilen:**
- **Lucia** — Çok düşük seviye, çok manuel iş
- **Clerk/Auth0** — SaaS, vendor lock-in, küçük self-host için saçma

### ADR-041: Argon2id (password hash)

**Karar:** Argon2id (winner of Password Hashing Competition).

**Parametreler:** memoryCost 64MB, timeCost 3, parallelism 4 → modern GPU brute force pratik değil.

**Reddedilen:** bcrypt (eski), scrypt (orta), PBKDF2 (zayıf)

## 9.6 Testing

### ADR-050: Vitest (unit + integration)

**Karar:** Jest yerine Vitest.

**Niye:**
- ESM native (Jest hala karmaşık ESM)
- Vite ile aynı transform pipeline (paylaşılan config)
- Watch mode hızlı
- Built-in coverage (v8)
- Jest API uyumlu (kolay migration)

### ADR-051: Playwright (E2E)

**Karar:** Cypress yerine Playwright.

**Niye:**
- Multi-browser (Chromium + Firefox + WebKit)
- Native parallelization
- Trace viewer süper güçlü
- Microsoft maintained, momentum yüksek
- Visual regression built-in (Chromatic gerekmez)

### ADR-052: msw (Mock Service Worker)

**Karar:** Apple/Google fixture'ları için msw.

**Niye:**
- Service worker level intercept → unit test ve E2E aynı mock paylaşır
- HTTP-handler tarzı tanım (Express-like)
- TypeScript first

**Reddedilen:** nock (sadece Node, browser yok), MirageJS (terkedildi)

## 9.7 DevOps & Infrastructure

### ADR-060: Docker + Compose (dev) → Kubernetes (V2 SaaS)

**Karar:** V1 için Docker Compose tek VM; V2 SaaS multi-tenant'a geçince EKS.

**Niye:**
- Compose ile küçük takım için yeter (web + worker + db + redis + minio + nginx 6 servis)
- Kubernetes overhead (etcd, control plane, ingress controller) küçük setup için saçma
- V2 multi-tenant ölçeklendirme gerekirse EKS

### ADR-061: nginx (reverse proxy)

**Karar:** nginx.

**Niye:**
- En çok bilinen, dökümante
- HTTP/2 + gzip + brotli
- `proxy_read_timeout 1800s` (AAB upload için)
- cert-manager / acme.sh ile auto-renew TLS

**Alternatif:** Caddy (auto-HTTPS) — V1.5 değerlendirilir, daha az config

### ADR-062: GitHub Actions (CI/CD)

**Karar:** GitHub Actions.

**Niye:**
- Repo'yla aynı yer
- Marketplace zengin
- Self-hosted runner opsiyonu

**Workflows:**
- `pr.yml` — lint + typecheck + unit + integration
- `release.yml` — Docker image build + push to registry + deploy
- `e2e-nightly.yml` — Playwright + sandbox Apple/Google
- `security.yml` — Snyk + Trivy + npm audit

### ADR-063: Pino + Prometheus + Grafana

**Karar:** Logs Pino → stdout → Docker log driver → log aggregator (Loki V1.5). Metrics Prometheus pull. Dashboards Grafana.

**Niye:** Open-source, kendi kontrolünde, vendor lock-in yok.

**Alternatif:** Datadog (SaaS, kolay ama pahalı) V2'de SaaS gelirine göre değerlendirilir.

### ADR-064: OpenTelemetry (V1.5)

**Karar:** V1.5'te tracing ekle. Bir job'un içindeki tüm Apple/Google çağrılarını span olarak izleme — debugging için kritik.

**Backend:** Tempo + Grafana.

## 9.8 Geliştirme Araçları

### ADR-070: ESLint 9 (flat config) + Prettier 3

**Karar:** Standart.

**Config:**
- `@typescript-eslint/strict-type-checked`
- `eslint-plugin-react-hooks`
- `eslint-plugin-import` (cycle detection)
- `eslint-plugin-security` (some best practices)

**Reddedilen:** Biome (single tool lint+format) — hızlı ama plugin ecosystem'i ESLint'in 1/10'u; V2 değerlendirilir.

### ADR-071: Conventional Commits + Changeset

**Karar:**
- Commit messages: `feat:`, `fix:`, `chore:`, `docs:`, vs.
- Release: Changeset (manual changelog entry per PR)

**Niye:** Otomatik CHANGELOG generation, semantic versioning, contributor görünürlük.

## 9.9 Versiyon Pinning Stratejisi

| Paket sınıfı | Strateji |
|--------------|---------|
| Framework (Next.js, React, Prisma) | Exact pin (`"15.0.3"`) — major upgrade plansız olmaz |
| Library (zod, sharp, pino) | Caret (`"^3.22.0"`) — minor güncellemeler dependabot |
| Dev tools (eslint, prettier, vitest) | Caret OK |
| Security-critical (argon2, jsonwebtoken, undici) | Exact pin + dependabot daily |

## 9.10 Browser Support Matrix

| Browser | Version | Note |
|---------|---------|------|
| Chrome / Edge | Son 2 versiyon | Primary |
| Firefox | Son 2 versiyon | Tested |
| Safari | 17+ | macOS Safari, iOS hariç |
| Mobile Safari | — | V1'de "open on desktop" mesajı |
| Mobile Chrome | — | Aynı |

**Polyfill yok** — modern browser API'ları (Fetch, EventSource, FormData, Web Crypto) doğrudan kullanılır.

## 9.11 Tahmini Maliyet (Self-Host VPS, V1.5)

| Servis | Sağlayıcı | Aylık |
|--------|-----------|-------|
| VM (8 vCPU, 16 GB RAM, 200 GB SSD) | Hetzner CPX41 | €30 |
| S3 storage (200 GB) | AWS S3 Standard | $5 |
| S3 transfer (50 GB out) | AWS | $5 |
| Domain (.com) | Cloudflare | $10/yıl |
| TLS sertifika | Let's Encrypt | $0 |
| Backup (90 gün retention) | AWS S3 + Glacier | $3 |
| Monitoring | Self-host Grafana | $0 |
| AWS Secrets Manager | 3 secret × $0.40 | $1.20 |
| **TOPLAM** | — | **~$45/ay** |

V1 lokal-only: $0 (yerel makinede docker-compose).

## 9.12 Geleceğe Yönelik Açık Sorular

| Soru | Şu anki cevap | Tetikleyici karar |
|------|--------------|-------------------|
| Bun runtime'a geçiş? | Hayır V1 | Bun 2.0 + ecosystem maturity |
| GraphQL eklemek? | Hayır | 3rd party SaaS integration ihtiyacı |
| Edge runtime (Cloudflare Workers)? | Hayır | Global latency >300ms olursa |
| WebAssembly modules? | Hayır | Image processing performansı dert olursa (sharp zaten C++) |
| Server-side AI (description generator)? | V2 | Müşteri talebi |
| Mobile native app? | Hayır | Web responsive yeterli |
| Realtime collab (Liveblocks)? | V2 | Multi-user team kullanımı yaygın olursa |

## 9.13 ADR Process

Her büyük teknoloji değişikliği için yeni ADR `docs/adr/NNN-title.md`:

```markdown
# ADR-NNN: <title>
Status: Proposed / Accepted / Superseded by ADR-XXX
Date: 2026-MM-DD
Author: @username

## Context
<problemi anlat>

## Decision
<seçilen yaklaşım>

## Consequences
+ avantajlar
- dezavantajlar
- ne zaman revize edilir
```

Bu doküman içindeki tüm ADR-XXX numaraları gelecek için referans noktasıdır. Bir kararı değiştirmek istediğinde yeni ADR yaz, eskinin `Status: Superseded by ADR-YYY` olarak güncelle.
