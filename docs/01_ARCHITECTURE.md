# 01 — Sistem Mimarisi

> **REVİZE (Multi-Tenant + SaaS-Ready):** V1.0'dan itibaren multi-tenant. Bu doküman tüm akışlarda tenant context'in nasıl taşındığını gösterir. Detay: [`10_MULTI_TENANT.md`](./10_MULTI_TENANT.md) ve [`11_SELF_HOST_TO_SAAS.md`](./11_SELF_HOST_TO_SAAS.md).

## 1.0 Multi-Tenant Request Lifecycle (kritik)

Her request bu sırayı izler:

```
Browser → Middleware (cookie parse) → TenantContext build → AsyncLocalStorage.run()
                                                                   │
                                                                   ▼
                                                       prisma → SET LOCAL app.current_tenant
                                                       redis → cacheKey.X() helpers
                                                       queue → enqueue { tenantId, ... }
                                                                   │
                                                                   ▼
                                                       RLS-filtered query results
```

Tenant context **session.activeTenantId**'den gelir; user'dan asla input alınmaz. Bir kullanıcı birden fazla tenant'a üye olsa bile aktif tenant cookie'de saklanır.

## 1.1 Yüksek Seviye Diyagram

```
┌─────────────────────────────────────────────────────────────────────────────┐
│                              KULLANICI TARAYICISI                            │
│                                                                              │
│   Next.js 15 (App Router) — React 19 + TypeScript + TailwindCSS              │
│   shadcn/ui + Radix Primitives + TanStack Query + Zustand (UI state)         │
│   React Hook Form + Zod (validation) + react-i18next (UI lokalizasyon)       │
│                                                                              │
│   ÖZELLİKLER:                                                                │
│   • Sürükle-bırak screenshot grid (dnd-kit)                                  │
│   • IndexedDB ile büyük dosya öncesi resim önizleme                          │
│   • SSE/WebSocket ile uzun süreli iş (upload, fetch) progress takibi         │
│   • Light/Dark mode, responsive (1024px+, tablet desteği opsiyonel)          │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │  HTTPS + JWT (httpOnly cookie)
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                         API GATEWAY (Next.js Route Handlers)                │
│                                                                              │
│   /api/v1/*  — bizim public API'mız (Zod ile validated)                     │
│   • Authentication middleware (next-auth v5 / Better-Auth)                  │
│   • Rate limiting (per-user, per-app, IP)                                    │
│   • Request ID + structured logging (pino)                                   │
│   • OpenAPI 3.1 spec auto-export (Zod-to-OpenAPI)                            │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │  fonksiyon çağrısı (monorepo)
                                   ▼
┌─────────────────────────────────────────────────────────────────────────────┐
│                            CORE SERVICE LAYER (Node)                         │
│                                                                              │
│   packages/core/  (saf TypeScript — Unity'den bağımsız)                     │
│                                                                              │
│   ┌─────────────────┐  ┌─────────────────┐                                  │
│   │ AppleAdapter    │  │ GoogleAdapter   │                                  │
│   │ • JWT (ES256)   │  │ • OAuth2 (RS256)│                                  │
│   │ • Metadata      │  │ • Edit session  │                                  │
│   │ • Screenshots   │  │ • Listings      │                                  │
│   │ • App Previews  │  │ • Images        │                                  │
│   │ • Builds/Subm.  │  │ • Tracks/AAB    │                                  │
│   └────────┬────────┘  └────────┬────────┘                                  │
│            │                    │                                            │
│            └────────────┬───────┘                                            │
│                         ▼                                                    │
│   ┌──────────────────────────────────────────────────────────┐              │
│   │ MetadataOrchestrator    ScreenshotOrchestrator           │              │
│   │ • Pull/push flow        • Reserve→PUT→Commit             │              │
│   │ • Locale normalize      • Dimension validate             │              │
│   │ • Dirty tracking        • LRU thumbnail cache            │              │
│   │ • Master JSON IO        • Bulk import from folder        │              │
│   └──────────────────────────────────────────────────────────┘              │
│                                                                              │
│   ┌──────────────────────────────────────────────────────────┐              │
│   │ JobQueue (BullMQ + Redis)                                │              │
│   │ • screenshot.upload         • metadata.push.bulk         │              │
│   │ • screenshot.fetch.all      • build.upload (AAB/IPA)     │              │
│   │ • app-preview.upload        • aso.keywords.refresh       │              │
│   └──────────────────────────────────────────────────────────┘              │
└──────────────────────────────────┬───────────────────────────────────────────┘
                                   │
        ┌──────────────────────────┼──────────────────────────┐
        ▼                          ▼                          ▼
┌──────────────┐         ┌────────────────┐        ┌──────────────────┐
│  PostgreSQL  │         │ Object Store   │        │  Secret Manager  │
│  (Prisma)    │         │ (S3/MinIO/FS)  │        │  (.p8, JSON)     │
│              │         │                │        │                  │
│ • users      │         │ • screenshots  │        │ • libsecret /    │
│ • orgs       │         │ • previews     │        │   keyring (dev)  │
│ • apps       │         │ • IPA/AAB      │        │ • AWS Secrets    │
│ • localizat. │         │ • master JSON  │        │   Mgr / Vault    │
│ • cred refs  │         │   exports      │        │   (prod)         │
│ • jobs       │         │ • thumbnails   │        │                  │
│ • audit logs │         │   (cached)     │        │                  │
└──────────────┘         └────────────────┘        └──────────────────┘
                                   │
                                   ▼
            ┌──────────────────────────────────────────────────┐
            │       DIŞ SERVİSLER (HTTP üzerinden)             │
            │                                                  │
            │  • api.appstoreconnect.apple.com/v1              │
            │  • androidpublisher.googleapis.com/v3            │
            │  • oauth2.googleapis.com/token                   │
            │  • Apple S3 uploadOperations URL'leri            │
            └──────────────────────────────────────────────────┘
```

## 1.2 Mimari İlkeler

### İlke 1 — **Adapter Pattern**
Her dış servis (Apple, Google) **adapter** sınıfında izole edilir. Adapter'ın public API'sı **Unity dünyasından bağımsız** — `Texture2D`, `EditorPrefs`, `Debug.Log` yok. Yerine native TypeScript primitives (Buffer, Stream, structured logger).

**Neden:** Mevcut Unity kodunda business logic ile Unity bağımlılıkları iç içe geçmiş (`AppStoreConnectAPI.cs` içinde `MiniJSON.Deserialize`, `Debug.LogError`, `EditorPrefs`). Bunu temizleyince hem testable hem reusable olur.

### İlke 2 — **Server-Authoritative, Client-Optimistic**
Tüm dış servis çağrıları **backend'den** yapılır. Frontend asla `.p8` veya service account JSON görmez; sadece backend'in döndürdüğü "credential ID" referansını tutar.

**Neden:** 
- Browser'da `crypto.subtle` ile ES256 imzalamak teknik olarak mümkün ama `.p8` dosyası tarayıcıya ulaşırsa **leak** sayılır (extension'lar okuyabilir, DevTools'tan görünür).
- CORS — Apple/Google CORS header döndürmez; tarayıcı direkt çağıramaz zaten.

### İlke 3 — **Long-Running Job = Background Queue**
3 saniyeden uzun süren her şey (screenshot batch upload, metadata fetch tüm locale'ler, AAB upload) **BullMQ job** olarak çalışır. Frontend job ID alır, SSE veya polling ile progress dinler.

**Neden:** Mevcut Unity kodu sync/blocking; UI donar (`EditorUtility.DisplayProgressBar` ile gizliyor). Web'de timeout, reverse-proxy gateway timeout, browser refresh durumu yönetmeliyiz.

### İlke 4 — **Append-Only Audit + Idempotency**
Her push işlemi audit log'a yazılır (kim, ne zaman, hangi app, hangi locale, hangi alanlar değişti, sonuç). Aynı request birden fazla kez tetiklenirse idempotency key ile tek seferde çalışır.

**Neden:** Apple/Google API'ları bazen sessizce başarısız olur veya 409 döner. Audit log olmadan "neyi gönderdik, ne olduğunu" rekonstrükte etmek imkansız.

### İlke 5 — **Local-First, Cloud-Optional**
İlk versiyon `docker-compose up` ile geliştiricinin makinesinde çalışır. Tüm artefactlar lokal disk + lokal Postgres + lokal MinIO. Cloud deploy V2.

**Neden:** Tek geliştirici (sen) için SaaS overhead'i yok. Ek olarak iOS build artefact'ları (IPA) ~200 MB; tek kişi için S3 maliyeti ve karmaşıklığı gereksiz.

## 1.3 Monorepo Yapısı

```
marquee-web/
├── apps/
│   ├── web/                          # Next.js 15 (frontend + API routes)
│   │   ├── src/app/                  # App Router pages
│   │   │   ├── (dashboard)/
│   │   │   │   ├── apps/             # App listesi
│   │   │   │   ├── apps/[id]/        # App detay (sekmeler)
│   │   │   │   │   ├── metadata/
│   │   │   │   │   ├── screenshots/
│   │   │   │   │   ├── previews/
│   │   │   │   │   ├── builds/
│   │   │   │   │   └── submission/
│   │   │   │   └── settings/
│   │   │   ├── api/v1/               # REST API endpoints
│   │   │   │   ├── auth/
│   │   │   │   ├── apps/
│   │   │   │   ├── metadata/
│   │   │   │   ├── screenshots/
│   │   │   │   ├── jobs/
│   │   │   │   └── webhooks/
│   │   │   └── login/
│   │   ├── src/components/           # React components (shadcn/ui patterns)
│   │   ├── src/lib/                  # API client, query keys, utilities
│   │   └── src/hooks/                # useApp, useScreenshots, useJob, ...
│   │
│   └── worker/                       # BullMQ worker process (ayrı container)
│       └── src/processors/           # screenshot, metadata, build, aso
│
├── packages/
│   ├── core/                         # Saf TS — business logic
│   │   ├── src/adapters/
│   │   │   ├── apple/
│   │   │   │   ├── AppleClient.ts         # HTTP wrapper + JWT
│   │   │   │   ├── AppleAuth.ts           # ES256 JWT, token cache
│   │   │   │   ├── AppleMetadata.ts       # Metadata pull/push
│   │   │   │   ├── AppleScreenshots.ts    # 3-step upload protocol
│   │   │   │   ├── AppleAppPreviews.ts    # Video upload (yine 3-step)
│   │   │   │   ├── AppleBuilds.ts         # Build listing + review submit
│   │   │   │   └── types/                 # Apple JSON:API tipler
│   │   │   ├── google/
│   │   │   │   ├── GoogleClient.ts        # HTTP wrapper + OAuth2 token
│   │   │   │   ├── GoogleAuth.ts          # RS256 JWT → access token
│   │   │   │   ├── GoogleEditSession.ts   # Edit lifecycle (open/commit/discard)
│   │   │   │   ├── GoogleListings.ts      # Metadata pull/push
│   │   │   │   ├── GoogleImages.ts        # Screenshot/icon/feature graphic
│   │   │   │   ├── GoogleTracks.ts        # AAB → track assignment
│   │   │   │   └── types/
│   │   ├── src/orchestrators/
│   │   │   ├── MetadataOrchestrator.ts    # iOS+Android pull/push birleşik akış
│   │   │   ├── ScreenshotOrchestrator.ts  # Validate + upload + thumbnail
│   │   │   ├── MasterJsonImporter.ts      # Master JSON → DB
│   │   │   └── MasterJsonExporter.ts      # DB → Master JSON
│   │   ├── src/locale/
│   │   │   ├── LocaleConverter.ts         # Apple ↔ Google ↔ master locale
│   │   │   ├── googlePlaySupportedLocales.ts  # HashSet (LocaleConverter.cs port)
│   │   │   └── appleLocaleMap.ts
│   │   ├── src/validation/
│   │   │   ├── metadataLimits.ts          # iOS/Android char limits
│   │   │   ├── screenshotSpecs.ts         # ScreenshotManager.cs spec port
│   │   │   └── previewSpecs.ts            # AppPreviewManager.cs spec port
│   │   ├── src/crypto/
│   │   │   ├── jwt.ts                     # ES256 + RS256 (native node:crypto)
│   │   │   └── md5.ts                     # sourceFileChecksum hesap
│   │   └── src/errors/
│   │       ├── AppleApiError.ts
│   │       ├── GoogleApiError.ts
│   │       └── ValidationError.ts
│   │
│   ├── db/                           # Prisma schema + migrations + repos
│   │   ├── prisma/schema.prisma
│   │   ├── src/repositories/
│   │   └── src/seed.ts
│   │
│   ├── storage/                      # Object storage abstraction (FS/S3/MinIO)
│   │   ├── src/StorageProvider.ts    # interface
│   │   ├── src/FilesystemStorage.ts
│   │   ├── src/S3Storage.ts
│   │   └── src/index.ts              # factory
│   │
│   ├── secrets/                      # Secret manager abstraction
│   │   ├── src/SecretProvider.ts     # interface (get/put/delete)
│   │   ├── src/FilesystemSecretProvider.ts   # ~/.marquee/secrets/ (dev)
│   │   ├── src/AwsSecretsProvider.ts
│   │   └── src/VaultProvider.ts
│   │
│   ├── jobs/                         # BullMQ job definitions (type-safe)
│   │   ├── src/queues.ts             # queue tanımları
│   │   ├── src/jobs/screenshot.ts
│   │   ├── src/jobs/metadata.ts
│   │   └── src/jobs/aso.ts
│   │
│   ├── api-contracts/                # Zod schemas (frontend + backend ortak)
│   │   ├── src/apps.ts
│   │   ├── src/metadata.ts
│   │   ├── src/screenshots.ts
│   │   └── src/jobs.ts
│   │
│   ├── ui/                           # shadcn/ui paylaşılan componentler
│   │   └── src/components/
│   │
│   └── eslint-config/
│
├── infra/
│   ├── docker/
│   │   ├── Dockerfile.web
│   │   ├── Dockerfile.worker
│   │   └── docker-compose.yml        # web + worker + postgres + redis + minio
│   ├── nginx/
│   └── terraform/                    # (V2 — cloud deploy için)
│
├── e2e/                              # Playwright (e2e: login → push metadata)
├── docs/                             # Bu plan + ADR'ler
├── package.json                      # workspace root
├── pnpm-workspace.yaml
├── turbo.json                        # Turborepo task runner
└── tsconfig.base.json
```

**Neden monorepo?** `packages/core` hem `apps/web`'in API route'larından hem `apps/worker`'dan import edilir. İki ayrı repo'da tutmak versiyon eşitleme cehennemi yaratır. Turborepo + pnpm workspaces ile hızlı build cache.

## 1.4 Request Akış Örnekleri

### Akış A — "iOS Tüm Metadata'yı Push'la"

```
[Browser]                  [Next.js Route]            [Core]                [Apple]
   │                              │                      │                     │
   │  POST /api/v1/apps/:id/      │                      │                     │
   │  metadata/push-all           │                      │                     │
   │  body: {locales:[...]}       │                      │                     │
   ├─────────────────────────────►│                      │                     │
   │                              │ validate (Zod)       │                     │
   │                              │ auth check           │                     │
   │                              │ rbac: ROLE_EDITOR    │                     │
   │                              │                      │                     │
   │                              │ enqueue job          │                     │
   │                              │ "metadata.push.bulk" │                     │
   │                              ├─────────────────────►│ BullMQ              │
   │                              │                      │                     │
   │  202 Accepted {jobId}        │                      │                     │
   │◄─────────────────────────────│                      │                     │
   │                              │                      │                     │
   │  GET /api/v1/jobs/:id/stream │                      │                     │
   │  (SSE, Last-Event-ID)        │                      │                     │
   ├─────────────────────────────►│                      │                     │
   │                              │ subscribe to Redis   │                     │
   │                              │ channel jobs::<id>   │                     │
   │                              │                      │                     │
   │                              │                      │ [WORKER PICKS UP]   │
   │                              │                      │ 1. Get credentials  │
   │                              │                      │    from Secret Mgr  │
   │                              │                      │ 2. AppleAuth.token()│
   │                              │                      │    → cache hit/JWT  │
   │                              │                      │ 3. For each locale: │
   │                              │                      │    publish progress │
   │  SSE: {progress: 12, total:35}                      │    ────────────────►│
   │◄─────────────────────────────│◄─────────────────────│ a. POST/PATCH       │
   │                              │ Redis pub/sub        │    appInfoLoc...    │
   │                              │                      │ b. POST/PATCH       │
   │                              │                      │    versionLoc...    │
   │  SSE: {progress: 13, ...}    │                      │    handle 409 grac. │
   │◄─────────────────────────────│                      │                     │
   │                              │                      │ ...                 │
   │                              │                      │ 4. Save audit log   │
   │                              │                      │ 5. Update app.dirty │
   │  SSE: {status:"done",        │                      │                     │
   │        succeeded:34,         │                      │                     │
   │        failed:1, errors:[]}  │                      │                     │
   │◄─────────────────────────────│                      │                     │
```

### Akış B — "Screenshot Upload (tek dosya)"

```
[Browser]                  [Next.js Route]            [Worker]            [Apple]
   │                              │                      │                  │
   │  POST /api/v1/screenshots    │                      │                  │
   │  (multipart/form-data)       │                      │                  │
   │  • file (binary)             │                      │                  │
   │  • appId, locale,            │                      │                  │
   │    displayType, ordinal      │                      │                  │
   ├─────────────────────────────►│                      │                  │
   │                              │ stream → temp file   │                  │
   │                              │ validate dimensions  │                  │
   │                              │ + size ≤ 8 MB        │                  │
   │                              │ move to objStorage   │                  │
   │                              │ (scratch/<uuid>.png) │                  │
   │                              │                      │                  │
   │                              │ enqueue job          │                  │
   │                              │ "screenshot.upload"  │                  │
   │                              │ {storageRef, …}      │                  │
   │                              ├─────────────────────►│ BullMQ           │
   │  202 {jobId,                 │                      │                  │
   │       previewUrl: blob URL}  │                      │                  │
   │◄─────────────────────────────│                      │                  │
   │                              │                      │                  │
   │  [progress via SSE…]         │                      │                  │
   │                              │                      │ [WORKER]         │
   │                              │                      │ 1. Auth          │
   │                              │                      │ 2. Get/Create    │
   │                              │                      │    screenshotSet │
   │                              │                      │    ─────────────►│
   │                              │                      │ 3. POST          │
   │                              │                      │    /appScreenshots│
   │                              │                      │    {fileName,    │
   │                              │                      │     fileSize}    │
   │                              │                      │    ─────────────►│
   │                              │                      │   ◄─ uploadOps[]  │
   │                              │                      │ 4. For each op:  │
   │                              │                      │    stream chunk  │
   │                              │                      │    PUT to S3 URL │
   │                              │                      │    ─────────────►│
   │                              │                      │    progress%     │
   │                              │                      │ 5. PATCH commit  │
   │                              │                      │    {uploaded,    │
   │                              │                      │     sourceCSum}  │
   │                              │                      │    ─────────────►│
   │                              │                      │ 6. Save to DB    │
   │                              │                      │    (screenshotId)│
   │                              │                      │ 7. Delete scratch│
```

### Akış C — "Master JSON Import"

```
[Browser]                          [Next.js Route]                    [Core]
   │                                       │                              │
   │  POST /api/v1/apps/:id/metadata/      │                              │
   │       import-master-json              │                              │
   │  (multipart: file)                    │                              │
   ├──────────────────────────────────────►│                              │
   │                                       │ parse JSON                   │
   │                                       │ validate _schema:1.0         │
   │                                       │ enqueue or run inline if     │
   │                                       │ <50 locale (fast path)       │
   │                                       │                              │
   │                                       ├─────────────────────────────►│
   │                                       │                              │ For each locale key:
   │                                       │                              │ 1. Locale normalize
   │                                       │                              │    (Apple + Google)
   │                                       │                              │ 2. If app=iOS:
   │                                       │                              │    AppleLocaleMap[k]
   │                                       │                              │    If app=Android:
   │                                       │                              │    LocaleConverter
   │                                       │                              │      .toGooglePlay
   │                                       │                              │ 3. Validate limits
   │                                       │                              │    (truncate +warn)
   │                                       │                              │ 4. UPSERT to DB
   │                                       │                              │    set dirty=true
   │                                       │                              │ 5. Return summary
   │                                       │◄─────────────────────────────│
   │  200 OK                               │                              │
   │  { matched: 12, created: 8,           │                              │
   │    skipped: 0, failed: 1,             │                              │
   │    unsupportedGooglePlay: ["fr-CH"],  │                              │
   │    truncated: [{locale:"de", field:"app_name", from:38, to:30}] }    │
   │◄──────────────────────────────────────│                              │
```

## 1.5 Deployment Topology

### Geliştirme (Lokal)

```
docker-compose up:
├── web        (Next.js dev server, port 3000)
├── worker     (tsx watch, BullMQ worker)
├── postgres   (port 5432, volume: ./data/postgres)
├── redis      (port 6379)
├── minio      (port 9000, console 9001, volume: ./data/minio)
└── mailhog    (smtp 1025, ui 8025 — auth email test için)

Volumes mount edilen yerel klasörler:
~/.marquee/secrets/  → /secrets (read-only, FilesystemSecretProvider okur)
./scratch/                  → /tmp/scratch (upload öncesi temp)
```

### Production (Self-Host, V1.5)

```
Single VM (8 vCPU, 16 GB RAM, 200 GB SSD):
├── nginx (reverse proxy, TLS terminate, gzip)
│   └── proxies /api/* and / to web
├── web container (Next.js standalone, behind nginx)
├── worker container (3 replica, hepsi aynı Redis'i tüketir)
├── postgres (managed RDS veya docker tek instance + daily backup)
├── redis (docker veya ElastiCache)
└── object storage:
    • S3 (prod) veya MinIO single-node (küçük takım)

Secrets:
├── AWS Secrets Manager (.p8, service account JSON)
├── IAM role ile worker container'a inject
└── DB encryption at rest

Backup:
├── postgres: pg_basebackup günlük → S3
├── object store: cross-region replication
└── secrets: AWS Secrets Manager rotation
```

### Production (Multi-Tenant SaaS, V2 — opsiyonel)

V2'ye geçişte ek olarak: per-org namespace isolation (DB row-level + storage key prefix), Stripe billing, org-bazlı rate limits, Kubernetes (EKS) deploy.

## 1.6 Servis Sınırları (kim ne yapar?)

| Katman | Sorumluluk | Sorumlu DEĞİL |
|--------|-----------|---------------|
| **Frontend** | UI state, form validation (UX), optimistic update, file picker, drag-drop, görüntü önizleme | İş kuralları, kimlik bilgisi erişimi, Apple/Google'a direkt çağrı |
| **API Routes** | Auth, RBAC, request validation (Zod), idempotency check, job enqueue veya senkron core çağrısı, response shape | Apple/Google API'ya direkt HTTP istek (worker veya core yapar), uzun süreli iş |
| **Core (adapter)** | Dış API ile konuşma, JWT/OAuth, request/response parse, hata sınıflandırma, locale normalize | DB yazma, persisting state, job orchestration |
| **Core (orchestrator)** | Adapter'ları kombine eden iş kuralları (örn. "metadata push tüm locale"), DB ile koordinasyon | HTTP req parse, auth |
| **Worker** | Long-running job execution, progress publish (Redis), retry, audit log yazma | Auth (worker'a job geldiğinde zaten yetki kontrolü yapılmış) |
| **DB Layer (Prisma repos)** | CRUD, transaction, optimistic lock (dirty bit) | İş kuralları |
| **Storage** | Binary blob save/get/delete (S3/FS abstraction) | İçerik anlama |
| **Secrets** | Credential put/get/delete | İçerik anlama |

## 1.7 Hata İşleme Felsefesi

Üç hata sınıfı:

1. **`ValidationError`** (400) — kullanıcı düzeltebilir (örn. screenshot 8 MB üstü, locale desteklenmiyor). Frontend'de inline form errors.
2. **`UpstreamError`** (502/503) — Apple/Google geçici hata. Otomatik retry (BullMQ exponential backoff: 5s, 10s, 20s, 40s — `GooglePlayAPI.UploadAABAsync` mantığı). Kullanıcıya "yeniden deniyoruz" gösterilir.
3. **`AuthError`** (401/403) — credential geçersiz veya scope yetersiz. Kullanıcıya açık mesaj + "Credentials" sayfasına link.

Bir de **`UpstreamSilentSuccess`** edge case'i var (Google Play draft app commit hatası aslında başarı). Bunu adapter seviyesinde tespit edip success'e mapliyoruz.

## 1.8 Observability

- **Structured logs**: `pino` + JSON formatı, `requestId`, `userId`, `appId`, `jobId` her log entry'sinde.
- **Metrics**: `prom-client` ile `/metrics` endpoint. Önemli sayaçlar:
  - `apple_api_requests_total{endpoint, status}`
  - `apple_screenshot_upload_duration_seconds`
  - `google_edit_commit_total{strategy, status}` (strategy = `managed`/`simple`/`draft_autosave`)
  - `job_duration_seconds{queue, status}`
  - `bullmq_active_jobs{queue}`
- **Traces**: OpenTelemetry — bir job'un içindeki tüm Apple/Google çağrılarını span olarak görmek için (opsiyonel V1.5).
- **Dashboard**: Grafana — preset dashboard JSON'ları `infra/grafana/` altında.

## 1.9 Test Stratejisi

| Seviye | Araç | Kapsama |
|--------|------|---------|
| **Unit** | Vitest | `packages/core/src/locale`, `validation`, `crypto` — saf fonksiyonlar |
| **Integration (mock)** | Vitest + `msw` (Mock Service Worker) | Adapter'lar — Apple/Google response fixture'larıyla |
| **Integration (canlı sandbox)** | Vitest + opsiyonel `@apple-sandbox` flag | App Store Connect "TestFlight" sandbox app + dummy Google Play developer account |
| **E2E** | Playwright | Login → app ekle → master JSON import → metadata push → screenshot upload (fixture image) |
| **Visual regression** | Playwright + Chromatic (V2) | Önemli sayfaların snapshot karşılaştırması |
| **Load** | k6 (V1.5) | 100 eş zamanlı screenshot upload — worker'ın doğru ölçeklendiğini gör |

Mock'lar için `tests/fixtures/apple/`, `tests/fixtures/google/` altında **gerçek API response'ları** (sensitive data redact edilmiş) tutarız. Bu sayede testler upstream değişikliklerinden bağımsız çalışır.
