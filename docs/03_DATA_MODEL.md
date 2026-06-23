# 03 — Data Model (PostgreSQL + Object Storage)

> **REVİZE (Multi-Tenant):** Bu dokümanın ŞEMA bölümü [`10_MULTI_TENANT.md`](./10_MULTI_TENANT.md) tarafından **devralındı** — tüm tablolar `tenantId String @db.Uuid` field'ı içerir, composite unique'ler tenantId ile başlar, RLS policies enable edilmiştir. Lütfen `10_MULTI_TENANT.md` 10.3'ü AUTHORITATIVE kaynak olarak kabul edin. Aşağıdaki orijinal şema **non-tenant** versiyonu — referans için saklandı ama production şema multi-tenant versiyonudur.

## 3.0 Felsefe

- **PostgreSQL** ana ilişkisel state (apps, localizations, jobs, audit) — Prisma ORM
- **Object Storage** (FS/S3/MinIO) binary blob'lar (screenshots, previews, IPA/AAB, master JSON export'lar)
- **Redis** ephemeral state — BullMQ queue, SSE pub/sub, OAuth token cache, rate-limit counter, idempotency cache
- **Secret Manager** API kimlik bilgileri (`.p8`, service account JSON) — DB'de **asla** ham haliyle yer almaz; sadece "secret reference" (örn. `aws-sm://marquee/cred-uuid` veya `file:///secrets/cred-uuid.p8`)

Bu üçü farklı bir hayat döngüsüne sahip:
- Postgres → ACID, point-in-time recovery, backup
- Object store → büyük, immutable, versioned (S3 versioning açık)
- Redis → cache (kaybolursa rebuild edilir)

## 3.1 PostgreSQL Schema (Prisma)

```prisma
// packages/db/prisma/schema.prisma

generator client {
  provider = "prisma-client-js"
  output   = "../node_modules/.prisma/client"
}

datasource db {
  provider = "postgresql"
  url      = env("DATABASE_URL")
}

// ──────────────────────────────────────────────────────────────────────────
// AUTH & ORG
// ──────────────────────────────────────────────────────────────────────────

model User {
  id            String   @id @default(uuid()) @db.Uuid
  email         String   @unique
  passwordHash  String?              // null if SSO-only
  displayName   String
  role          UserRole @default(EDITOR)
  isActive      Boolean  @default(true)
  lastLoginAt   DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  sessions      Session[]
  auditEvents   AuditEvent[]
  jobs          Job[]
  orgMemberships OrgMember[]

  @@index([email])
}

enum UserRole {
  OWNER       // sistem sahibi (V1 tek user)
  ADMIN       // org admin (V2)
  EDITOR      // metadata yazma + push
  VIEWER      // read-only
}

model Org {
  // V1 tek org (auto-create on first boot); V2 multi-tenant
  id            String   @id @default(uuid()) @db.Uuid
  name          String
  slug          String   @unique
  createdAt     DateTime @default(now())

  members       OrgMember[]
  credentials   Credential[]
  apps          App[]
}

model OrgMember {
  orgId   String   @db.Uuid
  userId  String   @db.Uuid
  role    UserRole
  org     Org      @relation(fields: [orgId], references: [id], onDelete: Cascade)
  user    User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([orgId, userId])
}

model Session {
  id            String   @id @default(uuid()) @db.Uuid
  userId        String   @db.Uuid
  token         String   @unique   // hashed; cookie taşır
  expiresAt     DateTime
  userAgent     String?
  ipAddress     String?
  createdAt     DateTime @default(now())

  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([token])
  @@index([userId])
  @@index([expiresAt])
}

// ──────────────────────────────────────────────────────────────────────────
// CREDENTIALS — secret reference only, ham veri SecretManager'da
// ──────────────────────────────────────────────────────────────────────────

model Credential {
  id            String   @id @default(uuid()) @db.Uuid
  orgId         String   @db.Uuid
  kind          CredentialKind
  name          String              // kullanıcının verdiği isim, "Apple Prod", "Google Play Main"
  // Apple-specific (CredentialKind=APPLE)
  appleKeyId    String?
  appleIssuerId String?
  googleClientEmail String?
  googleProjectId   String?
  // Secret reference — ham private key burada YOK
  secretRef     String              // örn. "aws-sm:///apps/gp/cred-<uuid>" veya "file:///secrets/<uuid>"
  // Test sonuçları
  lastTestedAt  DateTime?
  lastTestSucceeded Boolean?
  lastTestMessage String?
  // Hayat döngüsü
  createdBy     String   @db.Uuid
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  rotatedAt     DateTime?
  isActive      Boolean  @default(true)

  org           Org      @relation(fields: [orgId], references: [id], onDelete: Cascade)
  apps          App[]

  @@index([orgId, kind])
  @@index([isActive])
}

enum CredentialKind {
  APPLE        // App Store Connect (.p8 + keyId + issuerId)
  GOOGLE       // Google Play Service Account
}

// ──────────────────────────────────────────────────────────────────────────
// APPS
// ──────────────────────────────────────────────────────────────────────────

model App {
  id                String   @id @default(uuid()) @db.Uuid
  orgId             String   @db.Uuid
  credentialId      String   @db.Uuid

  platform          Platform
  bundleId          String              // com.foo.bar
  storeAppId        String?             // iOS: Apple internal ID; Android: bundleId ile aynı
  appName           String
  primaryLocale     String              // canonical (master JSON formatı)

  // iOS version state
  versionId         String?             // appStoreVersionId
  versionString     String?             // "1.2.3"
  status            String?             // "READY_FOR_SALE", "PREPARE_FOR_SUBMISSION", ...
  releaseType       ReleaseType?
  earliestReleaseDate DateTime?
  copyright         String?
  teamId            String?

  // Cached discovery (Apple/Google'dan geldi)
  availableLanguages          String[] @default([])   // canonical locale list
  discoveredScreenshotTypes   String[] @default([])   // ["APP_IPHONE_65", ...]
  discoveredPreviewTypes      String[] @default([])

  storeUrl          String?

  isConnected       Boolean  @default(true)
  dirty             Boolean  @default(false)          // herhangi bir locale dirty mi
  lastFetchedAt     DateTime?
  lastPushedAt      DateTime?

  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  createdBy         String   @db.Uuid

  org               Org      @relation(fields: [orgId], references: [id], onDelete: Cascade)
  credential        Credential @relation(fields: [credentialId], references: [id])
  localizations     AppLocalization[]
  screenshots       Screenshot[]
  appPreviews       AppPreview[]
  androidImages     AndroidImage[]
  jobs              Job[]
  auditEvents       AuditEvent[]
  masterJsonExports MasterJsonExport[]

  @@unique([orgId, platform, bundleId])
  @@index([orgId])
  @@index([credentialId])
}

enum Platform {
  IOS
  ANDROID
}

enum ReleaseType {
  MANUAL
  AFTER_APPROVAL
  SCHEDULED
}

// ──────────────────────────────────────────────────────────────────────────
// METADATA LOCALIZATIONS
// ──────────────────────────────────────────────────────────────────────────

model AppLocalization {
  id                        String   @id @default(uuid()) @db.Uuid
  appId                     String   @db.Uuid
  locale                    String              // canonical
  // Apple references
  appleAppInfoLocalizationId    String?         // /appInfoLocalizations/{id}
  appleVersionLocalizationId    String?         // /appStoreVersionLocalizations/{id}
  // Google references
  // Google'da listing per-language tek bir kaynak; ek ID gerekmez (key = packageName + language)
  // Common fields
  name               String?              // iOS ≤30, Android ≤50
  subtitle           String?              // iOS ≤30
  description        String?              // ≤4000
  keywords           String?              // iOS ≤100, comma-separated
  whatsNew           String?              // ≤4000
  promotionalText    String?              // iOS ≤170
  marketingUrl       String?
  supportUrl         String?
  privacyPolicyUrl   String?
  // Android-specific
  shortDescription   String?              // ≤80
  videoUrl           String?              // YouTube
  // State
  dirty              Boolean  @default(false)   // local edit, henüz push'lanmadı
  lastFetchedAt      DateTime?
  lastPushedAt       DateTime?
  createdAt          DateTime @default(now())
  updatedAt          DateTime @updatedAt

  app                App      @relation(fields: [appId], references: [id], onDelete: Cascade)

  @@unique([appId, locale])
  @@index([appId])
  @@index([dirty])
}

// ──────────────────────────────────────────────────────────────────────────
// SCREENSHOTS (iOS + Android phone screenshots tek tabloda)
// ──────────────────────────────────────────────────────────────────────────

model Screenshot {
  id                String   @id @default(uuid()) @db.Uuid    // bizim internal ID
  appId             String   @db.Uuid
  locale            String              // canonical
  // Apple
  appleScreenshotId    String?           // /appScreenshots/{id}
  appleScreenshotSetId String?           // /appScreenshotSets/{id}
  appleDisplayType     String?           // "APP_IPHONE_65"
  // Google
  googleImageId        String?           // Google Play image ID
  googleImageType      String?           // "phoneScreenshots", "sevenInch...", "tenInch..."
  // Common
  fileName          String
  width             Int
  height            Int
  ordinal           Int                  // 1-10 (iOS) / 1-8 (Android)
  state             ScreenshotState      // upload state
  // Storage refs
  storageKey        String?              // object store key (orijinal)
  thumbnailKey      String?              // object store key (256px thumbnail)
  // Upstream URLs (24h valid for Apple, auth-required for Google)
  upstreamUrl       String?
  sourceFileChecksum String?             // MD5
  fileSize          Int?                 // bytes
  // Hayat döngüsü
  uploadedAt        DateTime?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  createdBy         String?  @db.Uuid

  app               App      @relation(fields: [appId], references: [id], onDelete: Cascade)

  @@unique([appId, locale, appleDisplayType, ordinal], name: "uniq_apple_slot")
  @@unique([appId, locale, googleImageType, ordinal], name: "uniq_google_slot")
  @@index([appId, locale])
  @@index([state])
}

enum ScreenshotState {
  PENDING        // local'de, henüz upload edilmemiş
  UPLOADING      // S3'e PUT akıyor
  COMMITTING     // PATCH commit
  PROCESSING     // Apple/Google işliyor
  COMPLETE       // canlı
  UPLOAD_FAILED
  REJECTED       // store reddetti
}

// ──────────────────────────────────────────────────────────────────────────
// APP PREVIEWS (iOS video)
// ──────────────────────────────────────────────────────────────────────────

model AppPreview {
  id                String   @id @default(uuid()) @db.Uuid
  appId             String   @db.Uuid
  locale            String
  applePreviewId    String?
  applePreviewSetId String?
  applePreviewType  String              // "IPHONE_65" (APP_ prefix YOK)
  fileName          String
  width             Int?
  height            Int?
  ordinal           Int                 // 1-3
  state             ScreenshotState
  storageKey        String?
  thumbnailKey      String?             // poster image
  upstreamVideoUrl  String?
  upstreamPosterUrl String?
  sourceFileChecksum String?
  fileSize          Int?
  previewFrameTimeCode String?          // "00:00:00.000"
  mimeType          String?             // video/mp4, video/quicktime, video/x-m4v
  uploadedAt        DateTime?
  createdAt         DateTime @default(now())
  updatedAt         DateTime @updatedAt
  createdBy         String?  @db.Uuid

  app               App      @relation(fields: [appId], references: [id], onDelete: Cascade)

  @@unique([appId, locale, applePreviewType, ordinal])
  @@index([appId, locale])
}

// ──────────────────────────────────────────────────────────────────────────
// ANDROID GRAPHICS (icon, featureGraphic, tvBanner, promoGraphic)
// — phoneScreenshots vs Screenshot tablosunda; bu tablo single-image asset'ler
// ──────────────────────────────────────────────────────────────────────────

model AndroidImage {
  id            String   @id @default(uuid()) @db.Uuid
  appId         String   @db.Uuid
  language      String              // Google Play format (örn. "iw-IL")
  imageType     AndroidImageType
  googleImageId String?
  url           String?             // Google'dan dönen (auth-required)
  sha256        String?
  storageKey    String?             // bizdeki kopya
  thumbnailKey  String?
  width         Int?
  height        Int?
  state         ScreenshotState
  uploadedAt    DateTime?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  app           App      @relation(fields: [appId], references: [id], onDelete: Cascade)

  @@unique([appId, language, imageType], name: "uniq_single_asset")
  @@index([appId, language])
}

enum AndroidImageType {
  ICON                // 512x512 zorunlu
  FEATURE_GRAPHIC     // 1024x500
  TV_BANNER           // 1280x720
  PROMO_GRAPHIC       // 180x120
  // Çoklu olan screenshot tipleri Screenshot tablosunda
}

// ──────────────────────────────────────────────────────────────────────────
// JOBS (BullMQ ile paralel — DB'de durabilite ve audit için)
// ──────────────────────────────────────────────────────────────────────────

model Job {
  id            String   @id @default(uuid()) @db.Uuid
  bullJobId     String?  @unique        // BullMQ'daki ID
  orgId         String   @db.Uuid
  userId        String   @db.Uuid
  appId         String?  @db.Uuid
  kind          String              // "screenshot.upload", "metadata.push.bulk", ...
  status        JobStatus
  payload       Json                // request body snapshot
  result        Json?               // success summary
  error         Json?               // { code, message, retryable, stack? }
  progressCurrent Int   @default(0)
  progressTotal   Int   @default(1)
  progressStep    String?
  attempts      Int     @default(0)
  maxAttempts   Int     @default(3)
  idempotencyKey String?
  createdAt     DateTime @default(now())
  startedAt     DateTime?
  finishedAt    DateTime?

  user          User    @relation(fields: [userId], references: [id])
  app           App?    @relation(fields: [appId], references: [id], onDelete: SetNull)

  @@index([orgId, status])
  @@index([userId])
  @@index([appId])
  @@index([idempotencyKey])
  @@index([createdAt])
}

enum JobStatus {
  QUEUED
  RUNNING
  COMPLETED
  FAILED
  CANCELLED
  WAITING_RETRY
}

// ──────────────────────────────────────────────────────────────────────────
// AUDIT
// ──────────────────────────────────────────────────────────────────────────

model AuditEvent {
  id            String   @id @default(uuid()) @db.Uuid
  orgId         String   @db.Uuid
  userId        String?  @db.Uuid
  appId         String?  @db.Uuid
  action        String              // "metadata.push", "screenshot.upload", "credential.create"
  target        String?             // "app:<uuid>", "credential:<uuid>"
  diff          Json?               // before/after (sensitive alanlar redact)
  outcome       AuditOutcome
  errorCode     String?
  requestId     String?
  ipAddress     String?
  userAgent     String?
  createdAt     DateTime @default(now())

  user          User?   @relation(fields: [userId], references: [id], onDelete: SetNull)
  app           App?    @relation(fields: [appId], references: [id], onDelete: SetNull)

  @@index([orgId, createdAt])
  @@index([userId])
  @@index([appId])
  @@index([action])
}

enum AuditOutcome {
  SUCCESS
  FAILURE
  PARTIAL              // bulk push: bazı locale başarılı, bazı değil
}

// ──────────────────────────────────────────────────────────────────────────
// MASTER JSON EXPORTS (versiyonlanmış)
// ──────────────────────────────────────────────────────────────────────────

model MasterJsonExport {
  id            String   @id @default(uuid()) @db.Uuid
  appId         String   @db.Uuid
  storageKey    String              // object store key (gzip'li JSON)
  schema        String   @default("1.0")
  localeCount   Int
  sizeBytes     Int
  triggeredBy   String              // "manual", "auto-on-push", "scheduled"
  createdAt     DateTime @default(now())
  createdBy     String?  @db.Uuid

  app           App      @relation(fields: [appId], references: [id], onDelete: Cascade)

  @@index([appId, createdAt])
}

// ──────────────────────────────────────────────────────────────────────────
// SETTINGS (org-level key-value, V1: tek org)
// ──────────────────────────────────────────────────────────────────────────

model OrgSetting {
  orgId         String   @db.Uuid
  key           String
  value         Json
  updatedAt     DateTime @updatedAt

  @@id([orgId, key])
}

// Örnek key'ler:
//   "default.metadata.includeWhatsNew" → bool
//   "default.googlePlay.track" → "internal"|"alpha"|"beta"|"production"
//   "ui.theme" → "light"|"dark"|"system"
//   "limits.autoTruncate" → bool
```

### 3.1.1 Önemli Indeksler ve Constraint'ler

- **`App @@unique([orgId, platform, bundleId])`** — aynı org içinde aynı platform+bundleId tekrar yok
- **`AppLocalization @@unique([appId, locale])`** — bir locale per app sadece bir kayıt
- **`Screenshot @@unique([appId, locale, appleDisplayType, ordinal])`** — Apple slot collision önle
- **`Screenshot @@unique([appId, locale, googleImageType, ordinal])`** — Google slot collision önle (NULL constraint Postgres'te tek index gerekebilir, partial index)
- **`Job @@index([idempotencyKey])`** — idempotency lookup hızlı
- **`AuditEvent @@index([orgId, createdAt])`** — timeline query optimal

### 3.1.2 Migration Stratejisi

- Prisma Migrate (`prisma migrate dev` / `prisma migrate deploy`)
- Her PR migration içeriyorsa **schema diff** review zorunlu (squash etmiyoruz)
- Production'da `prisma migrate deploy` her release'de otomatik (Docker entrypoint)
- Backward-incompatible migration → iki release'e böl (önce add column nullable, kod yaz, sonra constraint ekle)

## 3.2 Object Storage Layout

```
marquee-bucket/  (S3 veya MinIO)
├── orgs/
│   └── <orgId>/
│       ├── apps/
│       │   └── <appId>/
│       │       ├── screenshots/
│       │       │   ├── <screenshotId>/
│       │       │   │   ├── original.png             # immutable, S3 versioning
│       │       │   │   └── thumbnail-256.webp       # auto-generated
│       │       │   └── ...
│       │       ├── previews/
│       │       │   └── <previewId>/
│       │       │       ├── original.mp4
│       │       │       └── poster.webp
│       │       ├── android-images/
│       │       │   └── <imageId>/
│       │       │       ├── original.png
│       │       │       └── thumbnail-256.webp
│       │       ├── master-json-exports/
│       │       │   └── <exportId>.json.gz
│       │       └── builds/
│       │           └── <jobId>/
│       │               ├── app.ipa
│       │               └── symbols.zip
│       └── credentials-mirror/    # OPSİYONEL — bizdeki cache kopyası, salt-okunur
│           └── <credentialId>/
│               └── meta.json      # ham private key DEĞİL, sadece metadata
├── scratch/                       # 1 saatte expire, ttl bucket policy
│   └── <jobId>-<uuid>.tmp
└── system/
    ├── logo.png
    └── flags/
        └── <locale>.svg            # UI bayrakları
```

**S3 ayarları:**
- Versioning **enabled** — screenshot replace olunca eskisi garbage collect edilmesin (audit için)
- Lifecycle policy: `scratch/` → 1 saat sonra delete
- Lifecycle policy: `master-json-exports/` → 90 günden eski versiyonlar Glacier
- KMS encryption at rest
- CORS: sadece bizim domain'imizden GET (signed URL ile)

**FS storage (lokal dev):**
- Aynı yapı, ama `./data/storage/` altında
- Versioning yok (dev için gereksiz)
- Thumbnail oluşturma sharp ile sync

## 3.3 Redis Schema

```
# Token cache
apple:token:<credentialId>           → JWT (TTL 15 dakika, expire'dan 5 dk önce refresh)
google:token:<credentialId>          → access_token (TTL 55 dakika)

# OAuth state (login akışı için, V2 SSO)
oauth:state:<nonce>                  → {provider, redirectUri} (TTL 10 dakika)

# Rate limit (sliding window)
ratelimit:user:<userId>:<minute>     → counter (TTL 70 saniye)
ratelimit:ip:<ip>:<minute>           → counter
ratelimit:push-all:<appId>:<minute>  → counter

# Idempotency cache (24h)
idempotency:<key>                    → {statusCode, body, headers}

# Job pub/sub (SSE)
pub/sub channel: jobs:<jobId>        → {type, payload}
list: jobs:<jobId>:history           → son N event (replay için, LTRIM ile budgeted)

# BullMQ namespaces
bull:metadata-push:*
bull:screenshot-upload:*
bull:build-upload:*

# Lock (distributed)
lock:fetch-metadata:<appId>          → uuid (TTL 5 dakika; iki kullanıcı eşzamanlı fetch'i blokla)
lock:upload-aab:<appId>              → uuid (TTL 30 dakika)
```

## 3.4 Secret Manager Layout

Backend ABSTRACTION → 3 implementation:

### `FilesystemSecretProvider` (dev/küçük self-host)

```
~/.marquee/secrets/             # mode 700
├── <credentialId>.p8                 # mode 600
├── <credentialId>.json               # mode 600
└── meta.json                         # {credentialId → kind, kid, projectId, ...}
```

Tüm dosyalar root tarafından okunur, ortak user web/worker container'a `--volume:ro` bind edilir.

### `AwsSecretsManager` (prod)

```
SecretId: apps/marquee/<env>/credentials/<credentialId>
SecretString: {
  "privateKeyPem": "-----BEGIN PRIVATE KEY-----\n...",
  "keyId": "ABC123",
  "issuerId": "...",
  "clientEmail": "...",
  "projectId": "..."
}
```

IAM policy: web/worker EC2 role sadece bu prefix'e read; rotation Lambda yazma.

### `VaultProvider` (Hashicorp Vault, V2)

```
secret/marquee/<env>/credentials/<credentialId>
```

## 3.5 Veri Hayat Döngüsü

| Veri | Oluşum | Güncelleme | Silme |
|------|--------|-----------|-------|
| `User` | Auth setup | Profile edit | Soft delete (`isActive=false`) |
| `Credential` | Settings UI | Rotate (yeni secretRef) | Hard delete + secret purge |
| `App` | Discover + connect | Fetch, manual edit | Disconnect = hard delete (CASCADE → localizations, screenshots) |
| `AppLocalization` | Fetch veya manual | UI edit (dirty=true), push (dirty=false) | App silinince CASCADE |
| `Screenshot` | Upload | Reorder (ordinal) | UI delete + Apple/Google delete |
| `AppPreview` | Upload | — | UI delete |
| `Job` | API call | Worker updates progress | 90 günden eski → cron job purge |
| `AuditEvent` | Her mutating op | — | 1 yıl sonra Glacier; legal requirement V2 |
| `MasterJsonExport` | Auto on push veya manual | — | 90 günden eski versiyonlar GC |

## 3.6 Backup Stratejisi

| Komponent | Frekans | Yer | Retention |
|-----------|---------|-----|-----------|
| Postgres | Günlük full + 5-dk WAL ship | S3 cross-region | 30 gün |
| Object store | S3 versioning + cross-region replication | Sec region | 90 gün versions |
| Secrets | AWS Secrets Manager built-in versioning | — | Sınırsız |
| Redis | Snapshot saat başı (RDB) | S3 | 7 gün |

**Restore drill** ayda bir: staging'e geri yükle, smoke test çalıştır.

## 3.7 Sızıntı Önleme

- DB seviyesinde **`Credential.secretRef` dışında ham key tutmuyoruz**
- Prisma middleware: `password`, `passwordHash`, `secretRef` alanları log'a yazılırken redact
- Audit `diff` field'ı kaydedilirken sensitive alanlar (her credential field, password) redact
- Backup dump'larda kolon-level encryption (pgcrypto) — gelecek faz

## 3.8 Seed Data

`packages/db/src/seed.ts`:

```ts
// Geliştirme için boot seed
await prisma.org.create({
  data: {
    id: "00000000-0000-0000-0000-000000000001",
    name: "My Studio",
    slug: "default",
    members: { create: { userId: ownerId, role: "OWNER" } },
  },
});

await prisma.user.create({
  data: {
    id: ownerId,
    email: "owner@example.com",
    passwordHash: await argon2.hash("change-me"),
    displayName: "Owner",
    role: "OWNER",
  },
});

// Master JSON sample import (test için)
await importMasterJson(testAppId, fixtures.wordStackSolitaire);
```

## 3.9 Açık Karar Noktaları

| Karar | Default | Alternatif | Tetikleyici |
|-------|---------|-----------|-------------|
| Postgres mı SQLite mı? | **Postgres** | SQLite ile tek dosya (Docker'sız dev hedefi) | Eğer "tıkla, çalış" hedefi varsa SQLite + Bun |
| Prisma mı Drizzle mi? | **Prisma** | Drizzle (daha hafif, daha az build overhead) | Prisma client size sorun olursa |
| BullMQ mı pg-boss mı? | **BullMQ** (Redis) | pg-boss (Postgres-based, Redis gerekmez) | Redis'i dış bağımlılık istemiyorsak |
| Object store: S3 mı FS mı? | **Abstraction** — config ile seç | — | Üretimde S3 zorunlu |
| Audit dedup? | Her event kaydet | Düşük-değerli event'leri toplu yaz | Audit tablosu çok büyürse |
