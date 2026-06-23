# 10 — Multi-Tenant Architecture (V1 Foundation)

V1'in **birinci günden** multi-tenant olmasının nedeni: **self-host'ta tek tenant olarak çalıştığında bile tüm tablo, query, cache ve session katmanları `tenantId`-aware olmalı**. SaaS'a geçişte refactor sıfır. Bu doküman tenant modelini, izolasyon mekanizmalarını ve cross-tenant saldırı vektörlerine karşı savunmaları detaylandırır.

## 10.0 Niye Multi-Tenant V1?

**Karşıt görüş:** "Self-host tek kullanıcı, multi-tenant ekstra karmaşıklık."

**Cevap:** Karmaşıklık **tutarlı**. Sonradan eklemek 10x maliyetli:
- Her query'ye `WHERE tenantId=?` eklemek = 200+ dosya değişikliği
- Her cache key'e `<tenantId>:` prefix eklemek = bug magneti
- Session/JWT'ye tenant scope eklemek = re-auth requirement
- Audit log'a tenant boyutu eklemek = backfill imkansız
- RBAC scope'unu org → tenant'a genişletmek = data leak riski

**V1'de:**
- Default org otomatik oluşturulur (`tenant-default`)
- Self-host kullanıcı bunu görmez, "Settings → Organization" gizli
- Database, cache, queue **tamamen tenant-scoped**

**V2 SaaS açılınca:**
- Signup → yeni `Tenant` row → 0 ek refactor
- Cross-tenant izolasyon zaten test edilmiş (Phase 1'den beri)

## 10.1 Tenancy Modeli Seçimi

3 yaygın model:

| Model | Açıklama | Avantaj | Dezavantaj |
|-------|----------|---------|-----------|
| **A — Shared DB + Shared Schema** | Tüm tenant'lar aynı tablolarda, `tenantId` column | Düşük cost, kolay backup, kolay migration | RLS şart; query mistake = data leak |
| **B — Shared DB + Schema-per-Tenant** | Postgres schemas; `SET search_path=tenant_x` | Daha yüksek izolasyon, per-tenant migration kolay | Migration N tablo × M tenant = patlama |
| **C — Database-per-Tenant** | Her tenant ayrı DB | Maksimum izolasyon, custom encryption per-tenant | Ops karmaşık, connection pool patlar |

### Karar: **Model A — Shared DB + Shared Schema + Postgres RLS**

**Niye:**
- 10K tenant'a kadar tek Postgres yeter (bizim ölçek için sınırsız)
- Postgres Row-Level Security (RLS) policies ile **runtime** kontrolü; query'de unuttuysan bile DB reddeder
- Backup tek `pg_dump`
- Migration tek `prisma migrate deploy`
- Per-tenant ihtiyaç (örn. enterprise customer dedicated DB) için **migration path** açık — V2.5+'ta hybrid model

**Risk azaltma:**
- RLS **fail-closed** (default policy: deny)
- Connection-level session var: `SET app.current_tenant = '<uuid>'`
- Test suite cross-tenant leak için **zorunlu** (bkz. `14_QA_TESTING.md`)

## 10.2 Tenant Hiyerarşisi

```
Tenant (en üst — bir müşteri/org/şirket)
├── Members (Users + Roles)
│   ├── OWNER       — billing, delete tenant
│   ├── ADMIN       — tenant settings, invitations
│   ├── MAINTAINER  — credentials, apps add/remove
│   ├── EDITOR      — metadata edit + push
│   └── VIEWER      — read-only
├── Apps (iOS / Android)
│   ├── Localizations
│   ├── Screenshots
│   ├── App Previews
│   └── Builds (V1.5)
├── Audit Log
├── Settings (preferences, defaults)
├── Invitations (pending)
└── Subscription (V2 SaaS)
    ├── Plan (Free / Pro / Team / Enterprise)
    ├── Usage (apps, locales, pushes/month)
    └── Billing (Stripe customer ID)
```

**Bir kullanıcı (User) birden fazla Tenant'ın üyesi olabilir** (V2 SaaS):
- `User ←→ TenantMembership ←→ Tenant` (many-to-many)
- Default tenant: kullanıcının ilk login'inde aktif olan (cookie'de saklanır)
- Tenant switcher: topbar'da, Cmd+K palette'de

## 10.3 Veritabanı Şeması (RLS-aware)

Tüm "tenant'a ait" tablolar şu kurala uyar:

1. **`tenantId` column zorunlu** (NOT NULL, indexed)
2. **Composite unique constraints `tenantId` içerir** (örn. App: `@@unique([tenantId, platform, bundleId])`)
3. **Foreign key'ler tenantId ile birlikte**: `App.credentialId → Credential.id` değil, **(tenantId, credentialId)** — tenant boundary'sini cross etmek imkansız hale gelir
4. **RLS policy** her tabloda

### 10.3.1 Prisma Schema (`packages/db/prisma/schema.prisma`)

```prisma
model Tenant {
  id            String   @id @default(uuid()) @db.Uuid
  slug          String   @unique           // "acme-corp" — URL-safe
  name          String
  // Tenant lifecycle
  status        TenantStatus @default(ACTIVE)
  deployedAs    DeployMode   @default(SELF_HOST)  // SELF_HOST | SAAS
  // SaaS-only fields (null in self-host)
  stripeCustomerId String?
  planTier      PlanTier   @default(FREE)
  trialEndsAt   DateTime?
  // Limits (per-plan; can be overridden)
  maxApps       Int       @default(5)
  maxMembers    Int       @default(3)
  maxPushesPerMonth Int   @default(100)
  // Metadata
  createdAt     DateTime  @default(now())
  updatedAt     DateTime  @updatedAt
  // Relations
  members       TenantMember[]
  invitations   Invitation[]
  credentials   Credential[]
  apps          App[]
  auditEvents   AuditEvent[]
  jobs          Job[]
  settings      TenantSetting[]
  subscription  Subscription?
  usageRecords  UsageRecord[]

  @@index([slug])
  @@index([status])
}

enum TenantStatus {
  ACTIVE
  SUSPENDED      // billing failure, abuse
  PENDING_DELETE // 30-day grace period
}

enum DeployMode {
  SELF_HOST
  SAAS
}

enum PlanTier {
  FREE
  PRO
  TEAM
  ENTERPRISE
}

model User {
  id            String   @id @default(uuid()) @db.Uuid
  email         String   @unique
  emailVerifiedAt DateTime?
  passwordHash  String?            // null = SSO-only
  displayName   String
  avatarUrl     String?
  // Account state
  status        UserStatus @default(ACTIVE)
  // MFA (V1.5+)
  totpSecret    String?            // encrypted
  webauthnEnabled Boolean @default(false)
  // Onboarding
  defaultTenantId String? @db.Uuid // cookie fallback
  // Audit
  lastLoginAt   DateTime?
  lastLoginIp   String?
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  sessions      Session[]
  memberships   TenantMember[]
  invitationsSent Invitation[] @relation("inviter")
  auditEventsCreated AuditEvent[]
  jobsTriggered Job[]
  apiTokens     ApiToken[]
}

enum UserStatus {
  ACTIVE
  DISABLED
  PENDING_VERIFICATION
}

model TenantMember {
  tenantId      String   @db.Uuid
  userId        String   @db.Uuid
  role          TenantRole
  // Per-app permissions (V2)
  allowedAppIds String[] @default([])  // boş = tüm app'ler
  // Metadata
  joinedAt      DateTime @default(now())
  invitedById   String?  @db.Uuid

  tenant        Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@id([tenantId, userId])
  @@index([userId])         // user → tenants lookup
}

enum TenantRole {
  OWNER
  ADMIN
  MAINTAINER
  EDITOR
  VIEWER
}

model Invitation {
  id            String   @id @default(uuid()) @db.Uuid
  tenantId      String   @db.Uuid
  email         String
  role          TenantRole
  tokenHash     String   @unique         // raw token email'de, hash DB'de
  invitedById   String   @db.Uuid
  expiresAt     DateTime                  // 7 gün
  acceptedAt    DateTime?
  acceptedById  String?  @db.Uuid
  createdAt     DateTime @default(now())

  tenant        Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  inviter       User     @relation("inviter", fields: [invitedById], references: [id])

  @@unique([tenantId, email], name: "uniq_pending_per_email")
  @@index([tokenHash])
  @@index([expiresAt])
}

model Session {
  id            String   @id @default(uuid()) @db.Uuid
  userId        String   @db.Uuid
  // Active tenant context — cookie'de sessionId, DB'de hangi tenant aktif
  activeTenantId String?  @db.Uuid
  tokenHash     String   @unique
  userAgent     String?
  ipAddress     String?
  expiresAt     DateTime
  createdAt     DateTime @default(now())
  lastUsedAt    DateTime @default(now())

  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([tokenHash])
  @@index([userId])
  @@index([expiresAt])
}

model ApiToken {
  // V2 — programmatic API access (PAT)
  id            String   @id @default(uuid()) @db.Uuid
  userId        String   @db.Uuid
  tenantId      String   @db.Uuid           // tenant-scoped!
  name          String                       // "CI bot"
  tokenHash     String   @unique
  prefix        String                       // "gp_abcdef..." gösterirken
  scopes        String[]                     // ["apps:read", "metadata:push"]
  lastUsedAt    DateTime?
  expiresAt     DateTime?
  revokedAt     DateTime?
  createdAt     DateTime @default(now())

  user          User     @relation(fields: [userId], references: [id], onDelete: Cascade)

  @@index([userId])
  @@index([tenantId])
  @@index([tokenHash])
}

// ──────────────────────────────────────────────────────────────────────────
// TENANT-SCOPED MODELS (every model has tenantId)
// ──────────────────────────────────────────────────────────────────────────

model Credential {
  id            String   @id @default(uuid()) @db.Uuid
  tenantId      String   @db.Uuid                  // ← TENANT SCOPE
  kind          CredentialKind
  name          String
  appleKeyId    String?
  appleIssuerId String?
  googleClientEmail String?
  googleProjectId   String?
  secretRef     String                              // SecretProvider URI
  lastTestedAt  DateTime?
  lastTestSucceeded Boolean?
  lastTestMessage String?
  createdById   String   @db.Uuid
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt
  rotatedAt     DateTime?
  isActive      Boolean  @default(true)

  tenant        Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  apps          App[]

  @@index([tenantId, kind])
  @@index([tenantId, isActive])
}

enum CredentialKind {
  APPLE
  GOOGLE
}

model App {
  id            String   @id @default(uuid()) @db.Uuid
  tenantId      String   @db.Uuid                  // ← TENANT SCOPE
  credentialId  String   @db.Uuid

  platform      Platform
  bundleId      String
  storeAppId    String?
  appName       String
  primaryLocale String

  // ... (önceki şemada olduğu gibi devam)
  versionId           String?
  versionString       String?
  status              String?
  releaseType         ReleaseType?
  earliestReleaseDate DateTime?
  copyright           String?
  teamId              String?

  availableLanguages          String[] @default([])
  discoveredScreenshotTypes   String[] @default([])
  discoveredPreviewTypes      String[] @default([])

  storeUrl      String?
  isConnected   Boolean  @default(true)
  dirty         Boolean  @default(false)
  lastFetchedAt DateTime?
  lastPushedAt  DateTime?

  createdById   String   @db.Uuid
  createdAt     DateTime @default(now())
  updatedAt     DateTime @updatedAt

  tenant        Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
  credential    Credential @relation(fields: [credentialId], references: [id])
  localizations AppLocalization[]
  screenshots   Screenshot[]
  appPreviews   AppPreview[]
  androidImages AndroidImage[]
  jobs          Job[]
  auditEvents   AuditEvent[]

  // ÖNEMLİ: tenant boundary'sini cross etmek imkansız — composite key
  @@unique([tenantId, platform, bundleId])
  @@index([tenantId])
  @@index([tenantId, credentialId])
}

// ... AppLocalization, Screenshot, AppPreview, AndroidImage, Job, AuditEvent
// hepsi `tenantId String @db.Uuid` field'ı + @@index([tenantId, ...]) içerir.
// Composite unique'ler tenantId ile başlar.

// Subscription + Usage (V2 SaaS)
model Subscription {
  id              String   @id @default(uuid()) @db.Uuid
  tenantId        String   @unique @db.Uuid
  stripeSubId     String?  @unique
  status          SubscriptionStatus
  planTier        PlanTier
  currentPeriodStart DateTime
  currentPeriodEnd   DateTime
  cancelAtPeriodEnd  Boolean @default(false)
  createdAt       DateTime @default(now())
  updatedAt       DateTime @updatedAt

  tenant          Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)
}

enum SubscriptionStatus {
  TRIALING
  ACTIVE
  PAST_DUE
  CANCELED
  UNPAID
}

model UsageRecord {
  // Per-month aggregate for billing
  id          String   @id @default(uuid()) @db.Uuid
  tenantId    String   @db.Uuid
  yearMonth   String                                // "2026-05"
  metric      String                                // "metadata.push", "screenshot.upload"
  count       Int      @default(0)
  recordedAt  DateTime @default(now())

  tenant      Tenant   @relation(fields: [tenantId], references: [id], onDelete: Cascade)

  @@unique([tenantId, yearMonth, metric])
  @@index([tenantId, yearMonth])
}
```

### 10.3.2 RLS Policy Migration

Postgres'te RLS, **migration ile aktive edilir** — Prisma raw SQL ile:

```sql
-- packages/db/prisma/migrations/0002_enable_rls/migration.sql

-- Enable RLS on every tenant-scoped table
ALTER TABLE "Credential" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "App" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AppLocalization" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Screenshot" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AppPreview" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AndroidImage" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Job" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "AuditEvent" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "TenantSetting" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Invitation" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "UsageRecord" ENABLE ROW LEVEL SECURITY;
ALTER TABLE "Subscription" ENABLE ROW LEVEL SECURITY;

-- Force RLS even for table owner (Prisma connection)
ALTER TABLE "Credential" FORCE ROW LEVEL SECURITY;
-- ... (her tabloda)

-- Standard policy: rows belong to current tenant
CREATE POLICY tenant_isolation_select ON "Credential"
  FOR SELECT USING ("tenantId" = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_insert ON "Credential"
  FOR INSERT WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_update ON "Credential"
  FOR UPDATE USING ("tenantId" = current_setting('app.current_tenant', true)::uuid)
              WITH CHECK ("tenantId" = current_setting('app.current_tenant', true)::uuid);

CREATE POLICY tenant_isolation_delete ON "Credential"
  FOR DELETE USING ("tenantId" = current_setting('app.current_tenant', true)::uuid);

-- Aynı pattern her tablo için. Helper SQL function ile DRY:
CREATE OR REPLACE FUNCTION apply_tenant_isolation(table_name text) RETURNS void AS $$
BEGIN
  EXECUTE format('
    CREATE POLICY tenant_iso_sel ON %I FOR SELECT USING ("tenantId" = current_setting(''app.current_tenant'', true)::uuid);
    CREATE POLICY tenant_iso_ins ON %I FOR INSERT WITH CHECK ("tenantId" = current_setting(''app.current_tenant'', true)::uuid);
    CREATE POLICY tenant_iso_upd ON %I FOR UPDATE USING ("tenantId" = current_setting(''app.current_tenant'', true)::uuid) WITH CHECK ("tenantId" = current_setting(''app.current_tenant'', true)::uuid);
    CREATE POLICY tenant_iso_del ON %I FOR DELETE USING ("tenantId" = current_setting(''app.current_tenant'', true)::uuid);
  ', table_name, table_name, table_name, table_name);
END;
$$ LANGUAGE plpgsql;

SELECT apply_tenant_isolation('Credential');
SELECT apply_tenant_isolation('App');
SELECT apply_tenant_isolation('AppLocalization');
-- ... ve diğerleri

-- BYPASS role for migrations + cron jobs
-- (sadece superuser veya special role kullanmalı)
CREATE ROLE gp_migration_admin BYPASSRLS;
GRANT ALL PRIVILEGES ON ALL TABLES IN SCHEMA public TO gp_migration_admin;
```

### 10.3.3 Tenant Context Injection (Prisma Middleware)

Her Prisma query'sinde, request başında set edilen **AsyncLocalStorage context**'inden tenantId çekilip Postgres'e push edilir:

```ts
// packages/db/src/tenantContext.ts
import { AsyncLocalStorage } from "node:async_hooks";

export interface TenantContext {
  tenantId: string;
  userId: string;
  role: TenantRole;
  requestId: string;
}

export const tenantStorage = new AsyncLocalStorage<TenantContext>();

export function getTenantContext(): TenantContext {
  const ctx = tenantStorage.getStore();
  if (!ctx) throw new Error("Tenant context not initialized — request did not pass through middleware");
  return ctx;
}

export function getCurrentTenantId(): string {
  return getTenantContext().tenantId;
}
```

```ts
// packages/db/src/prisma.ts — connection wrapper
import { PrismaClient } from "@prisma/client";
import { tenantStorage } from "./tenantContext";

export function createPrismaClient(): PrismaClient {
  const prisma = new PrismaClient({ log: ["error", "warn"] });

  // Each query: SET LOCAL app.current_tenant = '<uuid>'
  prisma.$use(async (params, next) => {
    const ctx = tenantStorage.getStore();
    if (ctx) {
      // SET LOCAL = transaction-scoped; safe under connection pooling
      await prisma.$executeRawUnsafe(`SET LOCAL app.current_tenant = '${ctx.tenantId}'`);
    }
    return next(params);
  });

  return prisma;
}
```

> **Connection pooling sorunu:** Prisma'nın pool'undaki bir connection birden fazla request tarafından serial olarak kullanılır. `SET LOCAL` **transaction-scoped** olduğu için her tx'te yeniden set edilmelidir. Prisma `$transaction` içinde SET LOCAL — middleware bunu garantili sağlar. **Eğer `$queryRaw` direkt connection kullanırsan transaction'sız**, RLS bypass edilir → bu yüzden `BYPASSRLS` role'ünü sadece migration ve admin cron için kullan.

> **Alternatif (V2 multi-region):** **PgBouncer transaction-mode**'da `SET LOCAL` çalışır; statement-mode'da çalışmaz. Postgres `pg_session_variables` extension'ı veya **per-tenant connection** pattern (Neon serverless gibi) daha güvenlidir.

### 10.3.4 Middleware Akışı

```
Browser request
   │
   ▼
[Next.js Route Handler]
   │
   ├── 1. Parse session cookie → userId
   ├── 2. Load session.activeTenantId (DB)
   ├── 3. Verify TenantMember exists (user is member of activeTenant)
   ├── 4. Load membership.role
   ├── 5. Build TenantContext { tenantId, userId, role, requestId }
   │
   ▼
[tenantStorage.run(ctx, async () => { ... })]
   │
   ├── Business logic
   │   ├── prisma.app.findMany() → middleware sets SET LOCAL → RLS filters
   │   ├── redis.get(`cache:${getCurrentTenantId()}:apps`) → tenant-scoped cache
   │   └── jobQueue.add('push', { tenantId: getCurrentTenantId(), ... })
   │
   ▼
Response (with tenant-isolated data)
```

```ts
// apps/web/src/middleware.ts (Next.js middleware)
import { NextRequest, NextResponse } from "next/server";

export async function middleware(req: NextRequest) {
  // Skip public routes
  if (req.nextUrl.pathname.startsWith("/api/v1/auth") || req.nextUrl.pathname === "/login") {
    return NextResponse.next();
  }

  const sessionCookie = req.cookies.get("gp_session")?.value;
  if (!sessionCookie) return NextResponse.redirect(new URL("/login", req.url));

  // Headers'a tenant context yaz (route handler okuyacak)
  const session = await validateSession(sessionCookie);
  if (!session) return NextResponse.redirect(new URL("/login", req.url));

  const tenantId = session.activeTenantId;
  if (!tenantId) return NextResponse.redirect(new URL("/onboarding/select-tenant", req.url));

  const res = NextResponse.next();
  res.headers.set("x-tenant-id", tenantId);
  res.headers.set("x-user-id", session.userId);
  res.headers.set("x-request-id", crypto.randomUUID());
  return res;
}

export const config = {
  matcher: [
    "/((?!api/v1/auth|api/v1/healthz|login|signup|_next|favicon).*)",
  ],
};
```

```ts
// apps/web/src/lib/withTenantContext.ts — route handler wrapper
import { tenantStorage } from "@marquee/db";
import { NextRequest } from "next/server";

export function withTenantContext<T>(
  handler: (req: NextRequest) => Promise<T>
): (req: NextRequest) => Promise<T> {
  return async (req) => {
    const tenantId = req.headers.get("x-tenant-id");
    const userId = req.headers.get("x-user-id");
    const requestId = req.headers.get("x-request-id");
    if (!tenantId || !userId) throw new Error("Missing tenant context — middleware did not run");

    const membership = await prisma.tenantMember.findUnique({
      where: { tenantId_userId: { tenantId, userId } },
    });
    if (!membership) throw new ForbiddenError("Not a member of this tenant");

    return tenantStorage.run({ tenantId, userId, role: membership.role, requestId }, () => handler(req));
  };
}

// Usage:
export const POST = withTenantContext(async (req) => {
  // prisma queries otomatik tenant-scoped
  const apps = await prisma.app.findMany();  // → RLS WHERE tenantId = current_tenant
  return Response.json({ apps });
});
```

## 10.4 URL ve Routing Stratejisi

Üç yaklaşım:

### A — Subdomain (acme.releaseflight.com)
- **Avantaj:** Brand'leşmiş feel, cookie isolation kolay
- **Dezavantaj:** Wildcard TLS, DNS setup karmaşık, self-host overkill

### B — Path-based (`/t/acme/apps`)
- **Avantaj:** Tek domain, tek TLS, self-host friendly
- **Dezavantaj:** Cookie shared, biraz daha az "branded"

### Karar: **B — Path-based for V1, A subdomain opsiyonu V2**

```
/login                          → public
/t/acme/dashboard               → tenant=acme
/t/acme/apps                    → tenant=acme
/t/acme/apps/<uuid>/metadata    → tenant=acme, app=<uuid>
/account/profile                → user-level (tenant-agnostic)
/account/tenants                → user'ın tüm tenants listesi
```

**Self-host:** Path otomatik `/t/default/...` redirect — kullanıcı görmez.

**SaaS:** Kullanıcı tenant switcher ile (`Cmd+K`) tenant değiştirir; path güncellenir.

V2 enterprise opsiyonu: Custom domain (acme.com → CNAME → bizim app), wildcard TLS Cloudflare ile.

## 10.5 Cache Isolation (Redis)

Her cache key'in **tenant prefix'i** olmalı:

```
apple:token:<tenantId>:<credId>
google:token:<tenantId>:<credId>
ratelimit:user:<tenantId>:<userId>:<minute>
ratelimit:push-all:<tenantId>:<appId>:<minute>
lock:google-edit:<tenantId>:<packageName>
idempotency:<tenantId>:<key>
session:<sessionId>                    → değer JSON: {userId, activeTenantId, ...}
pub/sub channel: jobs:<tenantId>:<jobId>
```

Helper:

```ts
// packages/cache/src/keys.ts
import { getCurrentTenantId } from "@marquee/db";

export const cacheKey = {
  appleToken: (credId: string) => `apple:token:${getCurrentTenantId()}:${credId}`,
  googleToken: (credId: string) => `google:token:${getCurrentTenantId()}:${credId}`,
  rateLimitUser: (userId: string, minute: number) =>
    `ratelimit:user:${getCurrentTenantId()}:${userId}:${minute}`,
  googleEditLock: (packageName: string) => `lock:google-edit:${getCurrentTenantId()}:${packageName}`,
  idempotency: (key: string) => `idempotency:${getCurrentTenantId()}:${key}`,
  jobsChannel: (jobId: string) => `jobs:${getCurrentTenantId()}:${jobId}`,
};
```

**Tenant silinince**: `redis.keys("*:<tenantId>:*")` + DELETE (lifecycle cleanup job).

## 10.6 BullMQ Queue Isolation

3 strateji:

### A — Shared queue + tenantId in payload
- Tek queue, her job payload `{ tenantId, ... }`
- Worker tüm tenant'ları işler
- **Risk**: bir tenant queue'yu doldurursa diğerleri bekler ("noisy neighbor")

### B — Queue-per-tenant
- `metadata-push:<tenantId>` ayrı queue
- İzole; ama 1000 tenant = 1000 queue → memory + connection patlar

### C — Hybrid: Shared queue + tenant-bazlı rate limit
- Tek queue
- Worker: aktif job'lardan **tenant başına max N concurrent** uygula (`bullmq` `Job.opts.group` veya manuel semaphore)
- Fair-share scheduling

### Karar: **C — Shared queue + per-tenant concurrency caps**

```ts
// packages/jobs/src/processors/metadata-push.ts
import { Worker } from "bullmq";

const TENANT_CONCURRENCY: Record<PlanTier, number> = {
  FREE: 2,         // 2 paralel push per tenant
  PRO: 5,
  TEAM: 10,
  ENTERPRISE: 20,
};

const worker = new Worker("metadata-push", async (job) => {
  const { tenantId } = job.data;
  const plan = await getTenantPlan(tenantId);
  const sem = getTenantSemaphore(tenantId, TENANT_CONCURRENCY[plan]);

  await sem.acquire();
  try {
    return await tenantStorage.run({ tenantId, userId: job.data.userId, ... }, async () => {
      return await processMetadataPush(job);
    });
  } finally {
    sem.release();
  }
}, {
  concurrency: 50,   // total worker concurrency
  connection: redis,
});
```

> Per-tenant semaphore: Redis distributed semaphore (`redislock` veya manual SETNX).

## 10.7 Object Storage Isolation

```
marquee-bucket/
└── tenants/
    └── <tenantId>/
        ├── apps/
        │   └── <appId>/
        │       ├── screenshots/<id>/original.png
        │       ├── screenshots/<id>/thumb-256.webp
        │       ├── previews/<id>/original.mp4
        │       └── android-images/<id>/...
        ├── credentials-meta/<credId>.json
        ├── master-json-exports/<exportId>.json.gz
        └── builds/<jobId>/app.ipa
└── scratch/<tenantId>/<jobId>-<uuid>.tmp   (1 saat TTL)
```

**Signed URL** generation: `tenantId` URL path'inde **ZORUNLU** + IAM policy ile bucket policy `s3:prefix = tenants/${tenantId}/*`.

**S3 bucket policy (prod):**
```json
{
  "Effect": "Allow",
  "Principal": { "AWS": "arn:aws:iam::ACCT:role/gp-app-role" },
  "Action": ["s3:GetObject", "s3:PutObject"],
  "Resource": "arn:aws:s3:::gp-bucket/tenants/${aws:PrincipalTag/tenantId}/*"
}
```

> Tenant-aware IAM **opsiyonel** (V2.5+); V1'de application-level enforcement yeterli.

## 10.7.1 Secret Storage Isolation

```
~/.marquee/secrets/        (self-host)
└── tenants/
    └── <tenantId>/
        ├── <credId>.p8
        └── <credId>.json
```

AWS Secrets Manager:
```
SecretId: apps/marquee/<env>/tenants/<tenantId>/credentials/<credId>
```

IAM policy tenant prefix:
```json
{
  "Effect": "Allow",
  "Action": "secretsmanager:GetSecretValue",
  "Resource": "arn:aws:secretsmanager:*:*:secret:apps/marquee/prod/tenants/${aws:PrincipalTag/tenantId}/*"
}
```

## 10.8 Audit Log

Her audit event **tenantId** ile yazılır:

```ts
await prisma.auditEvent.create({
  data: {
    tenantId: getCurrentTenantId(),       // ZORUNLU
    userId,
    appId,
    action: "metadata.push",
    target: `app:${appId}`,
    diff: redactedDiff,
    outcome: "SUCCESS",
    requestId,
    ipAddress,
    userAgent,
  },
});
```

**Cross-tenant audit view (admin only):** Sadece `OWNER` role'ündeki sistem yöneticisi (yani "platform admin") tüm tenant'ları görebilir. Bu, normal tenant OWNER'dan farklı bir kavram — `PlatformAdmin` modeli V2:

```prisma
model PlatformAdmin {
  // SaaS sahibi (sen) — tüm tenant'ları görme yetkisi
  userId        String   @unique @db.Uuid
  user          User     @relation(fields: [userId], references: [id])
  permissions   String[] @default([])   // ["audit:read", "tenant:suspend"]
  createdAt     DateTime @default(now())
}
```

PlatformAdmin RLS bypass için ayrı bir middleware path (`/admin/*`) — DB connection `BYPASSRLS` role'ü ile açılır. Çok dikkatli olunmalı, sadece audit endpoint'leri.

## 10.9 Cross-Tenant Saldırı Vektörleri

### Vektör 1 — IDOR (Insecure Direct Object Reference)
Saldırgan kendi tenant'ında, URL'de başka tenant'ın `appId`'sini deneyerek başkalarının data'sına erişmeye çalışır.

**Savunma:** RLS — `prisma.app.findUnique({ where: { id: appId } })` başka tenant'ın app'ini dönemez (filter otomatik).

**Test:** `14_QA_TESTING.md` 14.5.1 — "cross-tenant IDOR" test suite zorunlu, CI'da çalışır.

### Vektör 2 — Tenant Context Spoofing
Saldırgan `x-tenant-id` header'ı manipüle ederek başka tenant'a switch yapmaya çalışır.

**Savunma:** Header **middleware tarafından set edilir**, kullanıcıdan asla okunmaz. Kullanıcı tenant switch isterse `POST /api/v1/account/switch-tenant` → server `TenantMember` doğrular → session'ı günceller.

### Vektör 3 — Job Payload Manipulation
BullMQ worker job payload'ında `tenantId` field'ı; saldırgan başka tenantId enjekte edebilir mi?

**Savunma:** Job enqueue **API endpoint** üzerinden; endpoint `getCurrentTenantId()` ile tenantId set eder. BullMQ Redis tarafında bypass mümkün ama Redis'e network erişim olmamalı (internal-only).

### Vektör 4 — Cache Key Collision
İki tenant aynı cache key'i hedeflerse data leak.

**Savunma:** Tüm key'ler `cacheKey.X()` helper'ından — manuel string concat YASAK. ESLint kuralı: `redis.get/set` direkt kullanımı banned.

### Vektör 5 — File Path Traversal
Tenant A, `tenants/B/secret-credentials` path'ine erişmek için `../` enjekte edebilir mi?

**Savunma:** Path normalize + jail check (`SecurityHelpers.cs` C# kodundaki `IsSafePath` port). Storage abstraction `objectStore.put(scopedPath, ...)` her zaman `tenants/<current>/...` prefix'i kendisi ekler.

### Vektör 6 — Subdomain Takeover (V2)
Tenant slug `acme` silindi; saldırgan aynı slug ile signup → eski path'lere erişim.

**Savunma:** Tenant silindiğinde slug **soft-reserved** 90 gün (yeni signup alamaz). Sonra slug pool'a döner.

### Vektör 7 — Pivot via SSRF (Marketing/Support URL Preview)
Tenant A, `support_url` field'ına `http://169.254.169.254/...` (AWS metadata) yazar; sistem fetch ederse credential sızıntısı.

**Savunma:** URL preview/fetch yok V1'de. V1.5+ eklenirse SSRF allowlist + private IP blok.

### Vektör 8 — Tenant Enumeration
Saldırgan `/t/acme`, `/t/foo`, `/t/bar` deneyerek varolan tenant slug'larını öğrenir.

**Savunma:** Var/yok ayrımı yapma — geçersiz tenant erişimi `401 Unauthorized` (yetkisi yok mesajı). Slug enumeration için rate limit (10 farklı slug/dakika/IP).

## 10.10 Tenant Lifecycle

```
SIGNUP                        OBSERVE                  SUSPEND/DELETE
  │                              │                          │
  ▼                              ▼                          ▼
status=ACTIVE              ACTIVE → ...            ACTIVE → SUSPENDED (manual/billing)
trialEndsAt = +14gün                                ACTIVE → PENDING_DELETE (user request)
defaultTenantId set                                 30 gün grace → hard delete
member auto-create as OWNER                         (CASCADE her şey siler)
```

### Self-Host bootstrap
İlk başlangıçta `seed.ts`:
```ts
const defaultTenant = await prisma.tenant.upsert({
  where: { slug: "default" },
  create: {
    slug: "default",
    name: "My Studio",
    deployedAs: "SELF_HOST",
    status: "ACTIVE",
    planTier: "ENTERPRISE",   // self-host'ta limit yok
    maxApps: 999, maxMembers: 999, maxPushesPerMonth: 9999,
  },
  update: {},
});
const owner = await prisma.user.upsert(...);
await prisma.tenantMember.upsert({
  where: { tenantId_userId: { tenantId: defaultTenant.id, userId: owner.id } },
  create: { tenantId: defaultTenant.id, userId: owner.id, role: "OWNER" },
  update: {},
});
```

### SaaS Signup
```
POST /api/v1/auth/signup
  body: { email, password, displayName, tenantName, tenantSlug }
  ↓
Transaction:
  1. user = User.create()
  2. tenant = Tenant.create({ slug, name, status: ACTIVE, trialEndsAt: +14d, planTier: FREE })
  3. TenantMember.create({ tenantId, userId, role: OWNER })
  4. Session.create({ userId, activeTenantId: tenant.id })
  5. Stripe customer create (V2.1)
  ↓
Email verification + welcome email
```

### Tenant Delete
```
1. UI: "Delete tenant" (OWNER only, type-to-confirm)
2. Set Tenant.status = PENDING_DELETE
3. 30 gün grace → cron job:
   a. Cancel Stripe subscription
   b. Delete object store: `s3 rm --recursive s3://bucket/tenants/<id>/`
   c. Delete secrets: SecretProvider.deleteAll(tenantId)
   d. Delete Redis: SCAN + DEL `*:<id>:*`
   e. prisma.tenant.delete({ where: { id } })  → CASCADE her şeyi siler
   f. Audit (PlatformAdmin scope): "tenant.deleted"
```

## 10.11 Multi-Tenant Testing Stratejisi

Bkz. `14_QA_TESTING.md`. Özet:

- **Unit**: tenant context utility'leri (cacheKey, tenantStorage)
- **Integration**: RLS policy çalışıyor mu (mock Tenant A, query as Tenant B → 0 row)
- **E2E (Playwright)**: 2 farklı tenant kullanıcısı paralel browser oturumu → A'nın değişikliği B'de görünmez
- **Security**: Cross-tenant IDOR attack suite (her endpoint için)
- **Load**: 100 tenant × 10 user simultaneous push → fair-share çalışıyor mu

## 10.12 Tenant Migration Tools (V1.5+)

Self-host kullanıcısı SaaS'a geçmek isterse:

```bash
# CLI tool: gp-export
gp-export --tenant default --out my-tenant-export.tar.gz
  → DB dump (tenant-scoped) + secrets (encrypted) + object store

# SaaS tarafında:
gp-import --tenant new-saas-tenant --file my-tenant-export.tar.gz
  → Mevcut tenant'a UPSERT, secrets ayrı upload prompt
```

Çift yönlü çalışır (SaaS'tan export → self-host'a import).

## 10.13 Açık Tenancy Kararları

| Soru | Default | Tetikleyici alternatif |
|------|---------|------------------------|
| Bir user kaç tenant'ta üye olabilir? | Sınırsız | Plan limit'i (V2 Free=3) |
| Tenant slug değiştirilebilir mi? | Bir kez (signup'tan sonraki 7 gün) | Sonra OWNER ücretli plan ile |
| Cross-tenant veri paylaşımı? | Yok | "Shared workspace" V3 |
| Per-tenant subdomain? | V2 opsiyonel | Enterprise plan |
| Per-tenant DB (model C)? | V2.5 enterprise add-on | Müşteri talep ederse |
| Tenant import/export? | V1.5 | Hemen ihtiyaç yok |
| Tenant transfer (owner değişikliği)? | V1.5 | UI'da "Transfer ownership" flow |
| White-label (custom branding)? | V2.2 enterprise | Pazarlama gerekirse |
