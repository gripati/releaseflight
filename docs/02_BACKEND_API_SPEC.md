# 02 — Backend API Spec (Public REST API)

Bu, **bizim** API'mız (frontend ↔ backend kontratı). Apple/Google ile konuşan adapter'lar ayrı (bkz. `04_APPLE_INTEGRATION.md`, `05_GOOGLE_INTEGRATION.md`).

> **REVİZE (Multi-Tenant):** Tüm endpoint'ler **tenant-scoped path** üzerinden çalışır: `/api/v1/t/[tenantSlug]/...` formatında. Backward-compat için `/api/v1/...` da çalışır (session.activeTenantId fallback). Yeni endpoint'ler: `/api/v1/auth/signup` (SaaS only), `/api/v1/tenants/*`, `/api/v1/invitations/*`, `/api/v1/billing/*` (SaaS). Detaylar: [`10_MULTI_TENANT.md`](./10_MULTI_TENANT.md) ve [`11_SELF_HOST_TO_SAAS.md`](./11_SELF_HOST_TO_SAAS.md).

## 2.-1 Multi-Tenant Endpoint Eklemeleri (özet)

```
TENANT
  GET    /api/v1/tenants                       → user'ın üye olduğu tenants
  POST   /api/v1/tenants                       → create (SaaS signup ile birlikte tetiklenir)
  GET    /api/v1/tenants/:slug
  PATCH  /api/v1/tenants/:slug                 → name, slug change (OWNER)
  DELETE /api/v1/tenants/:slug                 → soft delete + 30d grace
  POST   /api/v1/tenants/:slug/transfer        → ownership transfer (OWNER)

ACCOUNT (tenant-agnostic)
  POST   /api/v1/account/switch-tenant         → session.activeTenantId update
  GET    /api/v1/account/profile
  PATCH  /api/v1/account/profile
  POST   /api/v1/account/mfa/enroll            → TOTP / WebAuthn (V1.5)

MEMBERS
  GET    /api/v1/t/:slug/members
  PATCH  /api/v1/t/:slug/members/:userId       → change role
  DELETE /api/v1/t/:slug/members/:userId       → remove

INVITATIONS
  GET    /api/v1/t/:slug/invitations
  POST   /api/v1/t/:slug/invitations           → invite by email + role
  DELETE /api/v1/t/:slug/invitations/:id       → revoke
  POST   /api/v1/invitations/accept            → public: accept by token

BILLING (SaaS V2)
  GET    /api/v1/t/:slug/subscription
  POST   /api/v1/t/:slug/subscription/checkout → Stripe checkout session
  POST   /api/v1/t/:slug/subscription/portal   → Stripe customer portal
  GET    /api/v1/t/:slug/usage                 → current period metrics

WEBHOOKS (SaaS)
  POST   /api/v1/webhooks/stripe               → Stripe event handler

PLATFORM ADMIN (SaaS, PlatformAdmin role)
  GET    /api/v1/admin/tenants
  GET    /api/v1/admin/audit
  POST   /api/v1/admin/tenants/:id/suspend
```

## 2.0 Genel Kurallar

| Konu | Karar |
|------|-------|
| Base URL | `/api/v1` (versiyonlu) |
| Format | JSON; multipart only for file uploads |
| Auth | httpOnly cookie + CSRF token header (`X-CSRF-Token`); programmatic API için Bearer PAT (V2) |
| Date format | ISO 8601 UTC (`2026-05-17T14:23:00Z`) |
| Pagination | Cursor-based: `?cursor=<opaque>&limit=50`, response `{data, nextCursor}` |
| Error shape | `{ error: { code, message, details?, requestId } }` — RFC 7807 (problem+json) uyumlu |
| Idempotency | Mutating endpoint'lerde `Idempotency-Key: <uuid>` header; tekrar gelirse aynı sonuç döner |
| Locale | Tüm `locale` parametreleri **canonical** (master JSON formatı: `en-US`, `tr`, `ja`, `ar-SA`...) — backend platform-spesifik dönüşümü yapar |
| File upload | `multipart/form-data` veya **presigned PUT** (V1.5): büyük dosyalar için backend presigned MinIO/S3 URL döner, browser direkt yükler |
| Rate limit | Per-user 600 req/min, per-IP 1200 req/min, per-app push-all 5/dakika; aşılırsa 429 + `Retry-After` |
| Response timing | < 500ms p99 (sync endpoint'ler); long-running iş **mutlaka 202 Accepted + jobId** |
| Validation | Zod schema; hata: `{ error: { code: "VALIDATION_ERROR", details: { field: [...] } } }` |

## 2.1 Endpoint Haritası (özet)

```
AUTH
  POST   /api/v1/auth/login                  → email/password (V1: tek user, env-based)
  POST   /api/v1/auth/logout
  GET    /api/v1/auth/me
  POST   /api/v1/auth/csrf-token

ORGANIZATION (V2)
  GET    /api/v1/orgs
  POST   /api/v1/orgs/:id/members             → invite

CREDENTIALS
  GET    /api/v1/credentials                  → list (masked, sadece referans)
  POST   /api/v1/credentials                  → create (yeni Apple/Google set)
  PUT    /api/v1/credentials/:id              → rotate
  DELETE /api/v1/credentials/:id
  POST   /api/v1/credentials/:id/test         → bağlantı testi
  POST   /api/v1/credentials/import-from-file → multipart .p8 veya JSON

APPS
  GET    /api/v1/apps                         → connected apps (iOS + Android)
  POST   /api/v1/apps                         → manual create (bundleId/packageName + platform)
  POST   /api/v1/apps/discover                → Apple/Google'dan listele
  GET    /api/v1/apps/:id
  PATCH  /api/v1/apps/:id                     → versionString, releaseType, copyright vs
  DELETE /api/v1/apps/:id                     → disconnect

METADATA
  GET    /api/v1/apps/:id/metadata            → all locales (DB cache)
  GET    /api/v1/apps/:id/metadata/:locale
  PATCH  /api/v1/apps/:id/metadata/:locale    → sets dirty=true
  POST   /api/v1/apps/:id/metadata/fetch      → 202 jobId (pull from store)
  POST   /api/v1/apps/:id/metadata/push       → 202 jobId (push tek locale veya hepsi)
  POST   /api/v1/apps/:id/metadata/import-master-json
  POST   /api/v1/apps/:id/metadata/export-master-json

SCREENSHOTS / IMAGES
  GET    /api/v1/apps/:id/screenshots         → ?locale=&deviceType= filter
  POST   /api/v1/apps/:id/screenshots/upload  → multipart, 202 jobId
  PATCH  /api/v1/apps/:id/screenshots/:scId   → reorder, change ordinal
  DELETE /api/v1/apps/:id/screenshots/:scId
  POST   /api/v1/apps/:id/screenshots/fetch   → 202 jobId
  POST   /api/v1/apps/:id/screenshots/bulk-import-zip
  POST   /api/v1/apps/:id/screenshots/presign → V1.5: presigned PUT URL

APP PREVIEWS (iOS only)
  GET    /api/v1/apps/:id/previews            → ?locale=&previewType=
  POST   /api/v1/apps/:id/previews/upload     → multipart (mp4/mov/m4v), 202 jobId
  PATCH  /api/v1/apps/:id/previews/:pvId
  DELETE /api/v1/apps/:id/previews/:pvId
  POST   /api/v1/apps/:id/previews/fetch      → 202 jobId

ANDROID IMAGES (Google graphics)
  GET    /api/v1/apps/:id/android-images      → ?language=&imageType=
  POST   /api/v1/apps/:id/android-images/upload
  DELETE /api/v1/apps/:id/android-images/:imgId

BUILDS (V1.5)
  GET    /api/v1/apps/:id/builds              → list from store
  POST   /api/v1/apps/:id/builds/upload       → IPA/AAB → 202 jobId
  POST   /api/v1/apps/:id/builds/:bid/submit-review


JOBS
  GET    /api/v1/jobs                         → list (filter ?status=)
  GET    /api/v1/jobs/:id                     → status + progress
  GET    /api/v1/jobs/:id/stream              → SSE
  POST   /api/v1/jobs/:id/cancel
  POST   /api/v1/jobs/:id/retry

AUDIT
  GET    /api/v1/audit                        → filter ?app=&user=&action=&from=&to=

SYSTEM
  GET    /api/v1/healthz                      → liveness
  GET    /api/v1/readyz                       → DB+Redis+Storage+SecretMgr
  GET    /api/v1/metrics                      → Prometheus (auth: bearer-protected)
```

## 2.2 Tip Tanımları (Zod — paylaşılan kontratlar)

`packages/api-contracts/src/` altında — frontend ve backend aynı dosyadan import eder. Bu **tek doğruluk kaynağı**.

### 2.2.1 Genel Tipler

```ts
// errors.ts
export const ApiError = z.object({
  code: z.enum([
    "VALIDATION_ERROR", "AUTH_REQUIRED", "FORBIDDEN", "NOT_FOUND",
    "CONFLICT", "RATE_LIMITED", "UPSTREAM_ERROR", "UPSTREAM_TIMEOUT",
    "CREDENTIAL_INVALID", "CREDENTIAL_EXPIRED", "INTERNAL_ERROR",
    "UNSUPPORTED_LOCALE", "FILE_TOO_LARGE", "INVALID_DIMENSIONS",
    "DIRTY_OVERWRITE_BLOCKED",
  ]),
  message: z.string(),
  details: z.record(z.unknown()).optional(),
  requestId: z.string(),
});

// platform.ts
export const Platform = z.enum(["ios", "android"]);

// locale.ts — master JSON formatı
export const Locale = z.string().regex(/^[a-z]{2,3}(-[A-Z]{2,4})?$/);
```

### 2.2.2 App Tipleri

```ts
// apps.ts
export const App = z.object({
  id: z.string().uuid(),
  platform: Platform,
  bundleId: z.string(),               // iOS: com.foo.bar, Android: aynısı
  storeAppId: z.string().nullable(),  // Apple internal ID / Android package = bundleId
  appName: z.string(),
  primaryLocale: Locale,
  status: z.string().nullable(),      // "READY_FOR_SALE", "PREPARE_FOR_SUBMISSION", ...
  versionString: z.string().nullable(),
  versionId: z.string().nullable(),   // Apple's appStoreVersionId
  releaseType: z.enum(["MANUAL", "AFTER_APPROVAL", "SCHEDULED"]).nullable(),
  earliestReleaseDate: z.string().datetime().nullable(),
  copyright: z.string().nullable(),
  teamId: z.string().nullable(),      // iOS only
  storeUrl: z.string().url().nullable(),
  credentialId: z.string().uuid(),    // hangi credential set'ini kullanır
  availableLanguages: z.array(Locale),
  discoveredScreenshotDisplayTypes: z.array(z.string()),  // ["APP_IPHONE_65", ...]
  discoveredPreviewTypes: z.array(z.string()),
  isConnected: z.boolean(),
  dirty: z.boolean(),                 // local edit'ler var mı (henüz push'lanmamış)
  lastFetchedAt: z.string().datetime().nullable(),
  lastPushedAt: z.string().datetime().nullable(),
});

export const DiscoverAppsRequest = z.object({
  credentialId: z.string().uuid(),
  platform: Platform,
});

export const DiscoverAppsResponse = z.object({
  apps: z.array(z.object({
    storeAppId: z.string(),
    bundleId: z.string(),
    appName: z.string(),
    primaryLocale: Locale,
    sku: z.string().optional(),  // iOS
  })),
});
```

### 2.2.3 Metadata Tipleri

```ts
// metadata.ts
export const Localization = z.object({
  locale: Locale,
  // iOS app-info localization (name, subtitle, privacyPolicy)
  name: z.string().max(50).nullable(),         // iOS ≤30, Android ≤50 (server validates per platform)
  subtitle: z.string().max(30).nullable(),     // iOS only
  // iOS version localization (description, keywords, whatsNew, promo, marketing/support url)
  description: z.string().max(4000).nullable(),
  keywords: z.string().max(100).nullable(),    // iOS only, comma-separated
  whatsNew: z.string().max(4000).nullable(),
  promotionalText: z.string().max(170).nullable(),  // iOS only
  marketingUrl: z.string().url().nullable(),
  supportUrl: z.string().url().nullable(),
  privacyPolicyUrl: z.string().url().nullable(),
  // Android-only
  shortDescription: z.string().max(80).nullable(),
  videoUrl: z.string().url().nullable(),       // YouTube URL
  // Internal
  localizationId: z.string().nullable(),       // Apple's appStoreVersionLocalization ID
  appInfoLocalizationId: z.string().nullable(),// Apple's appInfoLocalization ID
  dirty: z.boolean(),
  updatedAt: z.string().datetime(),
});

export const UpdateLocalizationRequest = z.object({
  // tüm alanlar opsiyonel — partial update
  name: z.string().nullable().optional(),
  subtitle: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  keywords: z.string().nullable().optional(),
  whatsNew: z.string().nullable().optional(),
  promotionalText: z.string().nullable().optional(),
  marketingUrl: z.string().nullable().optional(),
  supportUrl: z.string().nullable().optional(),
  privacyPolicyUrl: z.string().nullable().optional(),
  shortDescription: z.string().nullable().optional(),
  videoUrl: z.string().nullable().optional(),
});

export const FetchMetadataRequest = z.object({
  overwriteLocalEdits: z.boolean().default(false),
  // Eğer false ve dirty=true → 409 DIRTY_OVERWRITE_BLOCKED
});

export const PushMetadataRequest = z.object({
  locales: z.array(Locale).optional(),  // boşsa hepsi
  includeVersionSettings: z.boolean().default(true),  // versionString/releaseType/copyright
  includeWhatsNew: z.boolean().default(true),
});

export const ImportMasterJsonRequest = z.object({
  truncateToLimits: z.boolean().default(true),  // overflow olan alanlar otomatik kısalsın mı
  onlyNewLocales: z.boolean().default(false),    // yalnız DB'de olmayan locale'ler
  dryRun: z.boolean().default(false),            // sadece preview döndür, yazma
});

export const ImportMasterJsonResponse = z.object({
  matched: z.number(),         // mevcut locale'e match edip update edilen
  created: z.number(),         // yeni eklenen
  skipped: z.number(),
  failed: z.number(),
  unsupportedGooglePlay: z.array(Locale),  // GP'de yoksa uyarı
  truncated: z.array(z.object({
    locale: Locale,
    field: z.string(),
    fromLen: z.number(),
    toLen: z.number(),
  })),
  failures: z.array(z.object({
    locale: Locale,
    reason: z.string(),
  })),
});
```

### 2.2.4 Screenshot/Preview Tipleri

```ts
// screenshots.ts
export const ScreenshotInfo = z.object({
  id: z.string(),                  // Apple screenshot ID
  locale: Locale,
  displayType: z.string(),         // APP_IPHONE_65, ...
  fileName: z.string(),
  width: z.number(),
  height: z.number(),
  ordinal: z.number(),             // 1-10
  state: z.string(),               // "COMPLETE", "PROCESSING", "UPLOAD_FAILED", ...
  thumbnailUrl: z.string().url(),  // bizim CDN/storage'tan (cache'lenmiş)
  sourceFileUrl: z.string().url().nullable(),  // Apple signed URL (24h valid)
});

export const AppPreviewInfo = z.object({
  id: z.string(),
  locale: Locale,
  previewType: z.string(),         // IPHONE_65 (APP_ prefix YOK)
  fileName: z.string(),
  width: z.number().nullable(),
  height: z.number().nullable(),
  ordinal: z.number(),             // 1-3
  state: z.string(),
  videoUrl: z.string().url().nullable(),
  posterUrl: z.string().url().nullable(),
  previewFrameTimeCode: z.string().nullable(),  // "00:00:00.000"
});

export const AndroidImage = z.object({
  id: z.string(),                  // Google image ID
  language: Locale,
  imageType: z.enum([
    "phoneScreenshots", "sevenInchScreenshots", "tenInchScreenshots",
    "tvScreenshots", "wearScreenshots",
    "icon", "featureGraphic", "tvBanner", "promoGraphic",
  ]),
  url: z.string().url(),
  sha256: z.string(),
});

export const UploadScreenshotResponse = z.object({
  jobId: z.string().uuid(),
  // Browser'da hemen göstermek için
  optimisticThumbnail: z.string().url(),  // Object URL veya storage signed URL
  scratchRef: z.string(),                  // Scratch storage ID
});

export const ReorderScreenshotsRequest = z.object({
  // Yeni sıralama — id'ler sırayla
  ordering: z.array(z.string()),
});
```

### 2.2.5 Job Tipleri

```ts
// jobs.ts
export const JobStatus = z.enum([
  "queued", "running", "completed", "failed", "cancelled",
]);

export const JobKind = z.enum([
  "metadata.fetch", "metadata.push", "metadata.push.bulk",
  "screenshot.upload", "screenshot.upload.bulk", "screenshot.fetch.all",
  "preview.upload", "preview.fetch.all",
  "android-image.upload",
  "build.upload.ios", "build.upload.android",
  "submission.review",
]);

export const JobProgress = z.object({
  current: z.number(),
  total: z.number(),
  step: z.string(),               // "Uploading chunk 3/12", "Locale 5/35"
  detail: z.record(z.unknown()).optional(),
});

export const Job = z.object({
  id: z.string().uuid(),
  kind: JobKind,
  status: JobStatus,
  appId: z.string().uuid().nullable(),
  userId: z.string().uuid(),
  createdAt: z.string().datetime(),
  startedAt: z.string().datetime().nullable(),
  finishedAt: z.string().datetime().nullable(),
  progress: JobProgress,
  result: z.unknown().nullable(),  // job-spesifik
  error: z.object({
    code: z.string(),
    message: z.string(),
    retryable: z.boolean(),
  }).nullable(),
  attempts: z.number(),
  maxAttempts: z.number(),
});

// SSE event shape
export const JobEvent = z.discriminatedUnion("type", [
  z.object({
    type: z.literal("progress"),
    jobId: z.string().uuid(),
    progress: JobProgress,
  }),
  z.object({
    type: z.literal("log"),
    jobId: z.string().uuid(),
    level: z.enum(["info", "warn", "error"]),
    message: z.string(),
    timestamp: z.string().datetime(),
  }),
  z.object({
    type: z.literal("completed"),
    jobId: z.string().uuid(),
    result: z.unknown(),
  }),
  z.object({
    type: z.literal("failed"),
    jobId: z.string().uuid(),
    error: z.object({ code: z.string(), message: z.string() }),
  }),
]);
```

## 2.3 Önemli Endpoint Detayları

### 2.3.1 `POST /api/v1/apps/discover`

App Store'dan veya Google Play'den (credential set ile) tüm uygulamaları listele.

**Request:**
```json
{ "credentialId": "uuid", "platform": "ios" }
```

**Apple flow:**
1. CredentialStore'dan `keyId`, `issuerId`, `.p8` private key oku
2. `AppleAdapter.AuthenticateAsync()` → JWT cache
3. `GET /apps?limit=200&include=appInfos` (Apple API)
4. Response → `DiscoverAppsResponse` shape'ine map

**Google flow:**
1. Service account JSON oku
2. OAuth2 token al
3. Google Play Publisher API'da "uygulamaları listele" endpoint **yoktur** → kullanıcının package name'lerini elle girmesi gerekir. Bunun yerine "saved app templates" özelliği sun (lokal DB'de tutulan favori listesi).

**Response (200):**
```json
{
  "apps": [
    { "storeAppId": "1234567890", "bundleId": "com.foo.bar", "appName": "Foo", "primaryLocale": "en-US", "sku": "FOOBAR1" },
    ...
  ]
}
```

### 2.3.2 `POST /api/v1/apps/:id/metadata/fetch`

**Request:**
```json
{ "overwriteLocalEdits": false }
```

**Flow:**
1. App + credential lookup
2. Dirty check: app'in herhangi bir locale'i `dirty=true` ise ve `overwriteLocalEdits=false` → 409 CONFLICT:
   ```json
   { "error": {
       "code": "DIRTY_OVERWRITE_BLOCKED",
       "message": "Local edits exist on 3 locales. Push first or pass overwriteLocalEdits=true.",
       "details": { "dirtyLocales": ["tr", "ja", "ar-SA"] }
   }}
   ```
3. Enqueue `metadata.fetch` job → 202:
   ```json
   { "jobId": "uuid", "kind": "metadata.fetch", "estimatedSeconds": 15 }
   ```

**Worker:**
- Platform=iOS: `AppleMetadata.fetchAll()` → AppInfoLocalizations + AppStoreVersionLocalizations → merge per locale → DB UPSERT (dirty=false), `app.lastFetchedAt` güncel
- Platform=Android: `GoogleListings.fetchAll()` → DB UPSERT

### 2.3.3 `POST /api/v1/apps/:id/metadata/push`

**Request:**
```json
{
  "locales": ["en-US", "tr", "ja"],     // boşsa app.availableLanguages tümü
  "includeVersionSettings": true,        // iOS: versionString, releaseType, copyright, earliestReleaseDate
  "includeWhatsNew": true                // false ise whatsNew gönderilmez
}
```

**Flow:**
1. Validation:
   - Her locale'in metadata'sı limitlere uyuyor mu (iOS: name≤30, keywords≤100, ...)
   - `truncateToLimits` flag yok — sadece valid olan gönderilir, overflow → 422
2. Idempotency-Key kontrolü (24 saat içinde aynı key + aynı body → cached response)
3. Enqueue `metadata.push.bulk` job → 202 jobId

**Worker (iOS):**
- For each locale (paralel, max 5 eşzamanlı):
  - `AppleMetadata.upsertLocalization(appId, versionId, locale, fields)`
  - 409 Conflict (version state locked) → skip, audit'a yaz
- `includeVersionSettings=true` → `AppleMetadata.updateVersionSettings(versionId, ...)`
- Final summary → job.result

**Worker (Android):**
- `GoogleEditSession.open(packageName)` → editId
- For each locale: `GoogleListings.upsert(editId, locale, fields)`
- `GoogleEditSession.commit(editId)` — smart commit (managed → simple → draft fallback)
- Final summary

### 2.3.4 `POST /api/v1/apps/:id/screenshots/upload`

**Request:** `multipart/form-data`
- `file` (binary, max 8 MB enforced by middleware)
- `locale` (string)
- `displayType` (string, örn. `APP_IPHONE_65`)
- `ordinal` (number, 1-10) — opsiyonel; verilmezse sona ekler

**Sync validation (yanıt öncesi):**
1. File size ≤ 8 MB
2. PNG veya JPEG (magic byte sniff)
3. Dimensions decode (sharp/jimp) → spec'e match (iOS validSizes listesi)
4. Mevcut screenshot count + 1 ≤ 10
5. Geçici depola: `scratch/<jobId>.png`

**Response (202):**
```json
{
  "jobId": "uuid",
  "optimisticThumbnail": "https://<storage>/thumbnails/<scratchRef>?token=...",
  "scratchRef": "scratch-uuid",
  "validation": {
    "width": 1284,
    "height": 2778,
    "matchedSize": "1284x2778 (PRIMARY)"
  }
}
```

**Worker:**
1. AppleAuth.token()
2. `AppleScreenshots.findOrCreateSet(versionLocId, displayType)` → setId
3. `POST /appScreenshots` reserve → `uploadOperations[]`
4. For each operation (genelde 1, büyük dosyada chunked):
   - Stream chunk → PUT to S3 URL
   - Progress update (per chunk byte oranı)
5. Compute MD5 of full file
6. `PATCH /appScreenshots/:id` → `{ uploaded: true, sourceFileChecksum: md5 }`
7. Insert DB row (`screenshot_uploads` tablosu)
8. Delete scratch file
9. Return result → `{ screenshotId, state: "COMPLETE" | "PROCESSING" }`

**Hata path'leri:**
- Reserve başarısız (set full, locale yok) → ValidationError → user-facing
- PUT chunk failed → BullMQ retry (max 3, exponential)
- PATCH commit failed → Apple'da orphan asset kalır → cleanup job'ı 1 saat sonra delete eder

### 2.3.5 `PATCH /api/v1/apps/:id/screenshots/:scId`

Drag-drop sonrası ordinal değişikliği veya silme.

**Request:**
```json
{ "ordinal": 3 }
```

**Flow:**
- Apple, screenshot ordinal'ı **bulk reorder** ile değişir: `PATCH /appScreenshotSets/:setId/relationships/appScreenshots` body'sinde tüm ID'lerin yeni sırası.
- Tek bir screenshot'ın ordinal'ını değiştirmek için tüm set'in sırasını yeniden hesapla → tek bulk PATCH gönder.
- DB'de optimistic update.

### 2.3.6 `POST /api/v1/apps/:id/screenshots/bulk-import-zip`

Kullanıcı bir ZIP yükler (`<locale>/<displayType>/01.png`, `02.png` ... yapısında). Backend açar, her dosyayı validate eder, hepsini queue'ya atar.

**Request:** `multipart/form-data` — `file` (ZIP)

**Validation:**
- ZIP < 500 MB
- Maks 500 dosya
- İç yapı: `<locale>/<displayType>/<NN>.{png|jpg}`

**Response (202):**
```json
{
  "jobId": "uuid",
  "summary": {
    "filesFound": 142,
    "filesValid": 138,
    "filesRejected": [
      { "path": "fr/APP_IPHONE_65/03.png", "reason": "Unknown displayType: APP_IPHONE_65 not in app.discoveredScreenshotDisplayTypes" }
    ]
  }
}
```

### 2.3.7 `GET /api/v1/jobs/:id/stream` (SSE)

**Headers:**
- `Accept: text/event-stream`
- `Last-Event-ID: <opt>` — reconnect için

**Stream:**
```
id: 1
event: progress
data: {"current": 1, "total": 35, "step": "Locale 1/35: en-US"}

id: 2
event: log
data: {"level": "info", "message": "Created appStoreVersionLocalization", "timestamp": "..."}

id: 3
event: progress
data: {"current": 2, "total": 35, "step": "Locale 2/35: tr"}

...

id: 71
event: completed
data: {"succeeded": 34, "failed": 1, "failures": [{"locale": "ar-SA", "reason": "409 Conflict: app state locked"}]}
```

**Implementation:**
- BullMQ worker `job.updateProgress(payload)` çağırır
- Worker `events.on("progress", ...)` ile Redis pub/sub'a yazar (`channel: jobs:<id>`)
- Next.js route handler `for await` ile Redis sub'ı oluşturur
- 30 saniyede bir heartbeat `: ping\n\n` (proxy timeout için)
- Last-Event-ID gelirse: BullMQ job event history'sinden o ID sonrasını replay

### 2.3.8 `POST /api/v1/apps/:id/metadata/import-master-json`

**Request:** `multipart/form-data` — `file` (JSON)

**Sync flow** (master JSON < 1 MB ve < 50 locale ise inline):

1. Parse JSON, validate `_schema === "1.0"`
2. Tüm locale key'lerini topla (`_` prefix'leri skip)
3. Per-locale:
   - `locale_normalize(key, platform)` → canonical
   - Platform=iOS: AppleLocaleHelper map
   - Platform=Android: LocaleConverter.toGooglePlay → desteklenmeyen ise `unsupportedGooglePlay`'e ekle
   - DB lookup: matching locale var mı → UPSERT (dirty=true)
   - Limit overflow → `truncateToLimits` true ise UTF-16 surrogate-pair-safe kısalt + record
4. Return `ImportMasterJsonResponse`

**Async flow** (50+ locale → 202 jobId):
- Aynı işlem worker'da, progress callback ile.

**`dryRun=true`:** DB yazma; sadece response döndür (preview için).

## 2.4 Error Code Sözlüğü

| Code | HTTP | Anlam | Önerilen Frontend Davranışı |
|------|------|-------|------------------------------|
| `VALIDATION_ERROR` | 400 | Zod parse hatası | Inline form errors |
| `AUTH_REQUIRED` | 401 | Cookie yok/expired | Login sayfasına yönlendir |
| `FORBIDDEN` | 403 | RBAC fail | Toast "Bu işlem için yetkin yok" |
| `NOT_FOUND` | 404 | App/credential yok | "Kayıt bulunamadı" sayfası |
| `CONFLICT` | 409 | İş kuralı çakışması (dirty overwrite, state locked) | Modal: "Yine de devam et?" |
| `RATE_LIMITED` | 429 | Çok fazla istek | Toast + `Retry-After` saniye geri sayım |
| `UPSTREAM_ERROR` | 502 | Apple/Google hata döndü | Toast + "Detay için job log'a bak" |
| `UPSTREAM_TIMEOUT` | 504 | Apple/Google yanıt vermedi | Toast + auto-retry (worker zaten dener) |
| `CREDENTIAL_INVALID` | 401 | .p8 / JSON malformed veya expired | Credentials sayfasına yönlendir |
| `CREDENTIAL_EXPIRED` | 401 | Apple key rotate edildi | Aynı |
| `UNSUPPORTED_LOCALE` | 400 | Master JSON'da geçersiz locale | Inline warning listesi |
| `FILE_TOO_LARGE` | 413 | Screenshot >8MB, preview >500MB | Toast |
| `INVALID_DIMENSIONS` | 400 | Spec dışı çözünürlük | Toast + spec göster |
| `DIRTY_OVERWRITE_BLOCKED` | 409 | Fetch lokal değişikliği eziyor | Modal: liste + "Force fetch" / "Push first" |

## 2.5 OpenAPI Şeması

`packages/api-contracts/`'taki Zod şemaları `zod-to-openapi` ile build-time'da `openapi.yaml`'a derlenir → `/api/v1/openapi.json` endpoint serve eder → Swagger UI `/api-docs/` (dev only).

**Neden Zod-first?** OpenAPI'yi elle yazıp sonra TypeScript tipler üretmek vs. tek bir Zod şemasından hem runtime validation hem OpenAPI hem TypeScript tip — sonuncusu **drift'i imkansız** kılar.

## 2.6 Versiyonlama

- Path-based: `/api/v1/...`
- Breaking change → `/api/v2/...` yeni endpoint, eski en az 6 ay deprecated header (`Deprecation: true`, `Sunset: 2026-12-31`)
- Additive change (yeni opsiyonel field, yeni endpoint) → v1 içinde değişir

## 2.7 Webhook'lar (V2)

`POST /api/v1/webhooks` → kullanıcı kendi URL'ini kaydeder, biz event yollarız:

- `job.completed`, `job.failed`
- `metadata.pushed`, `screenshot.uploaded`
- `build.distributed`

HMAC-SHA256 signature header'da, retry exponential.
