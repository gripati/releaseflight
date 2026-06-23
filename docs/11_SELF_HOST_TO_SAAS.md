# 11 — Self-Host → SaaS Migration Playbook

V1 self-host olarak başlar. V2 SaaS açılır. **Aynı codebase, aynı binary, deploy-time configuration**. Bu doküman geçişi pürüzsüz hale getiren tüm kararları ve flag'leri içerir.

## 11.0 İlke

**"Code as-if SaaS from day 1, deploy as self-host."**

Tüm modeller, endpoint'ler, RBAC, audit, queue isolation **SaaS standartlarında** yazılır. Self-host'ta bunların bir kısmı **devre dışı** (signup, billing, marketing pages) ama **silinmez**.

V2 günü gelince:
1. `DEPLOY_MODE` env değişkeni değişir
2. Birkaç ek migration (Stripe webhooks, public pages)
3. **Zero refactor** — aynı schema, aynı code.

## 11.1 `DEPLOY_MODE` Environment Variable

Tek bir env değişkeni davranışın yönünü belirler:

```bash
# Self-host (V1)
DEPLOY_MODE=self_host
SELF_HOST_OWNER_EMAIL=owner@example.com
SELF_HOST_OWNER_PASSWORD=change-me-please  # ilk login sonrası UI'dan değiştirilir

# SaaS (V2)
DEPLOY_MODE=saas
SAAS_APP_URL=https://app.releaseflight.com
SAAS_MARKETING_URL=https://releaseflight.com
STRIPE_SECRET_KEY=sk_live_...
STRIPE_WEBHOOK_SECRET=whsec_...
SAAS_SIGNUP_ENABLED=true
SAAS_REQUIRE_EMAIL_VERIFICATION=true
SAAS_DEFAULT_TRIAL_DAYS=14
```

### 11.1.1 Davranışsal Farklar

| Özellik | `self_host` | `saas` |
|---------|-------------|--------|
| `/signup` endpoint | Disabled (404) | Enabled |
| `/login` page | Standart | + "Sign up" link + marketing CTA |
| Email verification | Skip (otomatik verified) | Mandatory |
| Marketing pages (`/`, `/pricing`) | Disabled (root → `/login`) | Enabled |
| Tenant creation | Boot'ta tek "default" tenant | Per signup yeni tenant |
| Stripe webhooks | Yok | Aktif |
| Subscription management UI | Hidden | Visible (Settings → Billing) |
| Plan limits enforcement | Bypass (limit max) | Enforce (per planTier) |
| Tenant slug | "default" (gizli) | User-chosen + uniqueness check |
| Tenant switcher in topbar | Hidden (tek tenant) | Visible |
| Platform admin panel (`/admin/*`) | Disabled | Enabled |
| Public API + PAT | Disabled V1, opsiyonel V1.5 | Enabled V2 |
| Webhook subscriptions | Disabled | Enabled V2.2 |
| Custom domains (V2.5) | N/A | Enterprise plan |

### 11.1.2 Feature Flag Implementasyonu

```ts
// packages/core/src/config/deploy.ts
import { z } from "zod";

const DeployConfigSchema = z.object({
  mode: z.enum(["self_host", "saas"]),
  selfHost: z.object({
    ownerEmail: z.string().email(),
    ownerPasswordEnv: z.string(),
  }).optional(),
  saas: z.object({
    appUrl: z.string().url(),
    marketingUrl: z.string().url(),
    stripeSecretKey: z.string(),
    stripeWebhookSecret: z.string(),
    signupEnabled: z.boolean(),
    requireEmailVerification: z.boolean(),
    defaultTrialDays: z.number().int().positive(),
  }).optional(),
});

export const deployConfig = DeployConfigSchema.parse({
  mode: process.env.DEPLOY_MODE,
  ...(process.env.DEPLOY_MODE === "self_host" && {
    selfHost: {
      ownerEmail: process.env.SELF_HOST_OWNER_EMAIL!,
      ownerPasswordEnv: process.env.SELF_HOST_OWNER_PASSWORD!,
    },
  }),
  ...(process.env.DEPLOY_MODE === "saas" && {
    saas: {
      appUrl: process.env.SAAS_APP_URL!,
      marketingUrl: process.env.SAAS_MARKETING_URL!,
      stripeSecretKey: process.env.STRIPE_SECRET_KEY!,
      stripeWebhookSecret: process.env.STRIPE_WEBHOOK_SECRET!,
      signupEnabled: process.env.SAAS_SIGNUP_ENABLED === "true",
      requireEmailVerification: process.env.SAAS_REQUIRE_EMAIL_VERIFICATION === "true",
      defaultTrialDays: parseInt(process.env.SAAS_DEFAULT_TRIAL_DAYS ?? "14"),
    },
  }),
});

export function isSelfHost(): boolean { return deployConfig.mode === "self_host"; }
export function isSaas(): boolean { return deployConfig.mode === "saas"; }
```

### 11.1.3 Boot-Time Validation

```ts
// apps/web/src/lib/startup.ts
export async function validateBootConfig(): Promise<void> {
  if (isSelfHost()) {
    // Self-host: signup endpoint disabled, default tenant must exist
    const defaultTenant = await prisma.tenant.findUnique({ where: { slug: "default" } });
    if (!defaultTenant) {
      await seedSelfHost();
    }
  } else {
    // SaaS: Stripe key must be valid
    await stripe.balance.retrieve();
    // Migration tables must include Subscription/UsageRecord (V2 migration check)
    const subModel = await prisma.$queryRaw`SELECT table_name FROM information_schema.tables WHERE table_name = 'Subscription'`;
    if (!subModel.length) throw new Error("V2 migration not run: prisma migrate deploy");
  }
}
```

### 11.1.4 Plain-HTTP self-host (no TLS) — scheme gating

A self-host box may run with `NODE_ENV=production` but be served over plain
`http://localhost:3000` (no TLS terminator in front). Several browser-hardening
features are HTTPS-only and **break or silently downgrade** an http box if they
key off `NODE_ENV` instead of the deployment scheme. The single source of truth
for "is this an HTTPS deployment?" is **`APP_URL`**, via the predicate:

```ts
// apps/web/src/lib/cookie-security.ts
process.env.NODE_ENV === "production" && !APP_URL.startsWith("http://")
```

Everything that assumes TLS gates on this (NOT on `NODE_ENV` alone):

| Concern | Where | Behaviour on `http://` APP_URL |
|---------|-------|--------------------------------|
| `Secure` flag on `gp_session` / `gp_csrf` cookies | `src/lib/cookie-security.ts` (`useSecureCookies`) → `session.ts`, `csrf.ts` | dropped — browsers discard `Secure` cookies over http, so without this login + CSRF both fail |
| CSP `upgrade-insecure-requests` | `src/lib/csp.ts` (`secure` flag) ← `middleware.ts` (per-request `x-forwarded-proto`) | omitted — otherwise every `/_next/*` subresource is rewritten to https with no listener |
| HSTS (`Strict-Transport-Security`) | `next.config.mjs` (`httpsDeployment`) | not sent — otherwise a non-`localhost` http host gets pinned to https forever |

Rules of thumb for new code:
- **Never** decide TLS behaviour from `NODE_ENV === "production"` alone. Use
  `useSecureCookies()` (cookies) or the `APP_URL`-scheme predicate (headers).
- **Never** use `__Host-` / `__Secure-` cookie name prefixes — they *require*
  `Secure` and so cannot exist on an http box.
- Absolute URLs (redirects, signed storage URLs, email links, webhook targets)
  must derive from `APP_URL`, never from the request scheme — `APP_URL` already
  carries the correct `http`/`https` and defaults to `http://localhost:3000`.
- A missing/unusual `APP_URL` in production **fails safe to HTTPS** — a real TLS
  deployment never silently loses its hardening.

For a real HTTPS deployment, set `APP_URL=https://…` (or put a TLS-terminating
proxy in front that sets `x-forwarded-proto: https`) and all three protections
re-engage automatically.

## 11.2 Marketing Pages (SaaS Only)

V2'de eklenir, **ayrı route group** olarak:

```
apps/web/src/app/
├── (marketing)/                    # SaaS only — middleware ile self-host'ta blok
│   ├── page.tsx                    # / (homepage)
│   ├── pricing/page.tsx            # /pricing
│   ├── features/page.tsx           # /features
│   ├── docs/[...slug]/page.tsx     # /docs/*
│   ├── changelog/page.tsx          # /changelog
│   └── layout.tsx                  # marketing topbar (login/signup CTA)
├── (auth)/                         # ortak
│   ├── login/page.tsx
│   ├── signup/page.tsx             # SaaS only — disabled in self-host (404)
│   ├── forgot-password/page.tsx
│   └── verify-email/[token]/page.tsx
├── (dashboard)/                    # ortak
│   └── t/[tenantSlug]/...
└── (admin)/                        # SaaS only — platform admin
    └── admin/...
```

```ts
// apps/web/src/app/(marketing)/layout.tsx
import { isSelfHost } from "@marquee/core/config";
import { notFound } from "next/navigation";

export default function MarketingLayout({ children }) {
  if (isSelfHost()) notFound();   // Self-host'ta marketing yok
  return <MarketingShell>{children}</MarketingShell>;
}
```

## 11.3 Signup Flow (SaaS V2)

```
Signup Form
   │
   ▼
[Email + Password + Display Name + Tenant Name + Tenant Slug]
   │
   ├── Validate (Zod):
   │   • email format + DNS MX check (opsiyonel)
   │   • password strength (zxcvbn ≥ 3)
   │   • tenantSlug: 3-30 chars, alphanumeric + dash, not in reserved list
   │   • tenantSlug: not soft-reserved (silinmiş tenant 90 gün cooldown)
   │
   ▼
[Captcha — hCaptcha free tier]
   │
   ▼
[Stripe customer create + trial subscription]
   │
   ▼
Transaction (Postgres):
   1. user = User.create({ status: PENDING_VERIFICATION })
   2. tenant = Tenant.create({ slug, planTier: FREE, trialEndsAt: now + 14 days })
   3. TenantMember.create({ tenantId, userId, role: OWNER })
   4. Subscription.create({ tenantId, status: TRIALING, planTier: FREE })
   5. Invitation token for email verification
   │
   ▼
Send verification email (Resend / SES)
   │
   ▼
User clicks link → POST /api/v1/auth/verify-email
   │
   ▼
[Set user.emailVerifiedAt + auto-login + redirect to /t/<slug>/onboarding]
```

```ts
// apps/web/src/app/api/v1/auth/signup/route.ts
import { withRateLimit } from "@/lib/rateLimit";
import { isSaas, isSelfHost } from "@marquee/core/config";

export const POST = withRateLimit({ key: "signup", limit: 5, windowMs: 60_000 }, async (req) => {
  if (isSelfHost()) return new Response("Not Found", { status: 404 });
  if (!deployConfig.saas?.signupEnabled) return new Response("Signups closed", { status: 403 });

  const body = SignupSchema.parse(await req.json());

  // Captcha verify
  const captchaOk = await verifyCaptcha(body.captchaToken, req.ip);
  if (!captchaOk) return Response.json({ error: { code: "CAPTCHA_FAILED" }}, { status: 400 });

  // Slug availability + soft-reserve check
  const existing = await prisma.tenant.findUnique({ where: { slug: body.tenantSlug } });
  if (existing) return Response.json({ error: { code: "SLUG_TAKEN" }}, { status: 409 });
  const reserved = await prisma.reservedSlug.findUnique({ where: { slug: body.tenantSlug } });
  if (reserved && reserved.reservedUntil > new Date()) {
    return Response.json({ error: { code: "SLUG_RESERVED" }}, { status: 409 });
  }

  // Stripe customer
  const stripeCustomer = await stripe.customers.create({
    email: body.email,
    metadata: { source: "saas-signup" },
  });

  // Transaction
  const result = await prisma.$transaction(async (tx) => {
    const user = await tx.user.create({
      data: {
        email: body.email,
        passwordHash: await argon2.hash(body.password),
        displayName: body.displayName,
        status: "PENDING_VERIFICATION",
      },
    });
    const tenant = await tx.tenant.create({
      data: {
        slug: body.tenantSlug,
        name: body.tenantName,
        deployedAs: "SAAS",
        planTier: "FREE",
        trialEndsAt: new Date(Date.now() + 14 * 24 * 3600 * 1000),
        stripeCustomerId: stripeCustomer.id,
        maxApps: 5, maxMembers: 3, maxPushesPerMonth: 100,
      },
    });
    await tx.tenantMember.create({
      data: { tenantId: tenant.id, userId: user.id, role: "OWNER" },
    });
    await tx.subscription.create({
      data: {
        tenantId: tenant.id,
        status: "TRIALING",
        planTier: "FREE",
        currentPeriodStart: new Date(),
        currentPeriodEnd: new Date(Date.now() + 14 * 24 * 3600 * 1000),
      },
    });
    return { user, tenant };
  });

  // Send verification email
  const verifyToken = crypto.randomUUID();
  await prisma.verificationToken.create({
    data: {
      tokenHash: await hashToken(verifyToken),
      userId: result.user.id,
      expiresAt: new Date(Date.now() + 24 * 3600 * 1000),
    },
  });
  await sendEmail({
    to: body.email,
    template: "verify-email",
    data: { url: `${deployConfig.saas.appUrl}/verify-email/${verifyToken}` },
  });

  return Response.json({ ok: true, message: "Check your email" });
});
```

## 11.4 Plan Tier Limit Enforcement

```ts
// packages/core/src/plans/limits.ts
export const PLAN_LIMITS: Record<PlanTier, PlanLimits> = {
  FREE:       { maxApps: 5,   maxMembers: 3,  maxPushesPerMonth: 100,  maxScreenshotsPerLocale: 10, support: "community" },
  PRO:        { maxApps: 25,  maxMembers: 10, maxPushesPerMonth: 1000, maxScreenshotsPerLocale: 10, support: "email" },
  TEAM:       { maxApps: 100, maxMembers: 25, maxPushesPerMonth: 5000, maxScreenshotsPerLocale: 10, support: "priority" },
  ENTERPRISE: { maxApps: 9999,maxMembers: 9999,maxPushesPerMonth:99999,maxScreenshotsPerLocale: 10, support: "dedicated" },
};

export async function enforceLimit(tenantId: string, metric: "apps.create" | "members.invite" | "metadata.push"): Promise<void> {
  if (isSelfHost()) return;   // self-host: limit yok

  const tenant = await prisma.tenant.findUnique({ where: { id: tenantId } });
  const limits = PLAN_LIMITS[tenant.planTier];

  switch (metric) {
    case "apps.create": {
      const count = await prisma.app.count({ where: { tenantId } });
      if (count >= limits.maxApps) throw new LimitExceededError("apps", count, limits.maxApps);
      break;
    }
    case "members.invite": {
      const count = await prisma.tenantMember.count({ where: { tenantId } });
      if (count >= limits.maxMembers) throw new LimitExceededError("members", count, limits.maxMembers);
      break;
    }
    case "metadata.push": {
      const ym = new Date().toISOString().slice(0, 7);   // "2026-05"
      const usage = await prisma.usageRecord.findUnique({
        where: { tenantId_yearMonth_metric: { tenantId, yearMonth: ym, metric: "metadata.push" }},
      });
      if (usage && usage.count >= limits.maxPushesPerMonth) {
        throw new LimitExceededError("monthly pushes", usage.count, limits.maxPushesPerMonth);
      }
      break;
    }
  }
}

// Usage tracking — her başarılı action sonrası
export async function recordUsage(tenantId: string, metric: string, count = 1): Promise<void> {
  if (isSelfHost()) return;
  const ym = new Date().toISOString().slice(0, 7);
  await prisma.usageRecord.upsert({
    where: { tenantId_yearMonth_metric: { tenantId, yearMonth: ym, metric }},
    create: { tenantId, yearMonth: ym, metric, count },
    update: { count: { increment: count }},
  });
}
```

## 11.5 Stripe Integration (V2.1)

### 11.5.1 Pricing Model

| Plan | Price (USD/mo) | maxApps | maxMembers | maxPushes |
|------|---------------|---------|-----------|-----------|
| Free | $0 (14-day trial) | 5 | 3 | 100/ay |
| Pro | $29 | 25 | 10 | 1000/ay |
| Team | $99 | 100 | 25 | 5000/ay |
| Enterprise | Contact | sınırsız | sınırsız | sınırsız + SLA + SSO + custom domain |

### 11.5.2 Webhook Handler

```ts
// apps/web/src/app/api/v1/webhooks/stripe/route.ts
import Stripe from "stripe";

export async function POST(req: NextRequest) {
  const sig = req.headers.get("stripe-signature");
  const body = await req.text();
  const event = stripe.webhooks.constructEvent(body, sig, deployConfig.saas.stripeWebhookSecret);

  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
      await handleSubscriptionChange(event.data.object as Stripe.Subscription);
      break;
    case "customer.subscription.deleted":
      await handleSubscriptionCancel(event.data.object as Stripe.Subscription);
      break;
    case "invoice.payment_failed":
      await handlePaymentFailed(event.data.object as Stripe.Invoice);
      break;
    case "invoice.payment_succeeded":
      await handlePaymentSucceeded(event.data.object as Stripe.Invoice);
      break;
  }
  return Response.json({ received: true });
}
```

### 11.5.3 Self-Service Billing Portal

Stripe **Customer Portal** kullan — kendi billing UI'ı yazma.

```ts
export async function POST() {
  const ctx = getTenantContext();
  requireRole(ctx, ["OWNER"]);
  const tenant = await prisma.tenant.findUnique({ where: { id: ctx.tenantId }});

  const session = await stripe.billingPortal.sessions.create({
    customer: tenant.stripeCustomerId,
    return_url: `${deployConfig.saas.appUrl}/t/${tenant.slug}/settings/billing`,
  });
  return Response.json({ url: session.url });
}
```

## 11.6 Onboarding Flow (SaaS)

```
Verify email → /t/<slug>/onboarding
   │
   ├── Step 1: Welcome — feature tour (skippable)
   ├── Step 2: Choose your platform
   │   • iOS
   │   • Android
   │   • Both
   ├── Step 3: Add first credential
   │   • Apple .p8 drop / Google JSON drop
   │   • Test connection (live)
   ├── Step 4: Connect first app
   │   • Discover apps (Apple) / Enter package name (Android)
   ├── Step 5: First push success → confetti 🎉
   │
   ▼
Redirect to /t/<slug>/dashboard
```

UI'da progress bar, geri/ileri butonlar, "Skip for now" linki her step'te.

## 11.7 Email Templates

Self-host'ta email opsiyonel (SMTP yoksa skip), SaaS'ta zorunlu.

| Template | Trigger | Provider |
|----------|---------|----------|
| `welcome` | Signup tamamlandı | Resend / SendGrid / SES |
| `verify-email` | Signup veya email değişikliği | Aynı |
| `password-reset` | Forgot password | Aynı |
| `invitation` | Member invite | Aynı |
| `payment-failed` | Stripe webhook | Aynı |
| `trial-ending` | Trial bitmesine 3 gün | Cron job |
| `usage-warning` | Aylık limit %80 | Cron job |

Templates: `apps/web/emails/` — React Email (Resend ile native).

```tsx
// apps/web/emails/verify-email.tsx
import { Button, Container, Text } from "@react-email/components";

export function VerifyEmail({ url }: { url: string }) {
  return (
    <Container>
      <Text>Welcome to Release Flight!</Text>
      <Button href={url}>Verify your email</Button>
    </Container>
  );
}
```

## 11.8 Platform Admin Panel (`/admin/*`, SaaS Only)

Sen (SaaS sahibi) tüm tenant'ları izlemek için:

```
/admin/dashboard            → MAU, signups today, churn, MRR
/admin/tenants              → all tenants list (filter, search, sort)
/admin/tenants/<id>         → detail (members, apps, usage, audit)
/admin/tenants/<id>/suspend → manual suspension
/admin/audit                → cross-tenant audit (read-only)
/admin/feature-flags        → per-tenant flag overrides
/admin/jobs                 → all jobs across tenants
```

Erişim: `PlatformAdmin` modeli (bkz. `10_MULTI_TENANT.md` 10.8). Ayrı bir route group + ayrı middleware (RLS bypass).

**ÖNEMLI**: Bu panel **sadece prod ortamda 2-factor zorunlu** + audit log'da her admin aksiyonu kayıt.

## 11.9 Migration: Self-Host'tan SaaS'a Tenant Transfer

Self-host kullanıcısı SaaS'a geçmek isterse (örn. takım büyüdü, biz host edelim):

### 11.9.1 Export (Self-Host CLI)

```bash
gp-cli export \
  --tenant default \
  --include-secrets \
  --output ./my-tenant.tar.gz \
  --encrypt-with-passphrase
```

Çıktı:
```
my-tenant.tar.gz (encrypted GPG)
├── tenant.json              # Tenant + Member + Settings
├── credentials/
│   ├── meta.json
│   ├── <id>.p8.enc
│   └── <id>.json.enc
├── apps/
│   └── <appId>/
│       ├── app.json         # full record
│       ├── localizations.json
│       └── screenshots/<id>/original.png + thumbnail
├── audit.jsonl              # last 90 days
└── manifest.json            # checksum + version
```

### 11.9.2 Import (SaaS UI)

```
Settings → Migration → Import from self-host
   ├── Upload .tar.gz
   ├── Decryption passphrase
   ├── Preview (apps, members, credentials count)
   ├── Confirm → Job enqueued
   │
   ▼
[Worker: Import job]
   1. Decrypt + extract
   2. For each app: UPSERT into current SaaS tenant
   3. For each credential: SecretProvider.put + update DB ref
   4. For each screenshot: download from archive, upload to S3
   5. Member invite emails (existing users link, new users invitation)
   │
   ▼
Summary: "Imported X apps, Y locales, Z screenshots"
```

### 11.9.3 Reverse: SaaS → Self-Host

Aynı CLI tool reverse:
```bash
gp-cli download-tenant-export \
  --tenant my-saas-tenant \
  --api-key gp_pat_...
# → my-saas-tenant.tar.gz indirilir
```

Sonra self-host'a `gp-cli import --tenant default --file my-saas-tenant.tar.gz`.

**Bu, müşteri lock-in olmamasını garanti eder** — pazarlama avantajı + güven kaynağı.

## 11.10 SLO Differences

| Metrik | Self-Host (best-effort) | SaaS (contractual) |
|--------|-------------------------|---------------------|
| Uptime | 99.0% | 99.9% (43m/month max downtime) |
| API p99 | < 500ms | < 300ms |
| Support response | Community Discord | Email 24h (Pro), 4h (Team), 1h (Enterprise) |
| Maintenance window | Anytime | Announced 7 days prior |
| Backup retention | 30 days | 90 days |
| Disaster recovery (RTO) | 1 hour | 15 minutes |
| Security patches | When user updates | Automatic same-day |
| Status page | Self-monitor | status.releaseflight.com |

## 11.11 Status Page (V2)

Statuspage.io alternative: self-host **Cachet** veya **Atlassian Statuspage**.

Components:
- API
- Workers (background jobs)
- Apple Integration (depends on `api.appstoreconnect.apple.com`)
- Google Integration
- Object Storage

Each: operational / degraded / outage; incident history.

## 11.12 SaaS Deployment Checklist (V2 Launch)

- [ ] `DEPLOY_MODE=saas` env applied to prod
- [ ] DNS: `app.releaseflight.com` → app, `releaseflight.com` → marketing (Cloudflare)
- [ ] TLS wildcard `*.releaseflight.com` (Let's Encrypt + cert-manager)
- [ ] Stripe live key + webhook endpoint
- [ ] Email provider (Resend/SES) DKIM + SPF
- [ ] Status page live
- [ ] Postgres prod (managed RDS) + read replica
- [ ] Redis cluster (3-node)
- [ ] S3 bucket + lifecycle + replication
- [ ] AWS Secrets Manager IAM
- [ ] Sentry/error tracking
- [ ] Grafana dashboards live
- [ ] PagerDuty / on-call rotation
- [ ] Privacy policy + Terms of service
- [ ] GDPR DPA template (V2.2)
- [ ] hCaptcha account
- [ ] Initial pricing page + signup form A/B test
- [ ] Onboarding email sequence
- [ ] Customer support: Intercom / Front / Plain
- [ ] Internal admin panel tested
- [ ] Load test: 1000 simultaneous signups
- [ ] Security audit clean
- [ ] Beta closed → public launch announcement

## 11.13 SaaS Costs Estimate (1000 active tenants, ortalama Pro plan)

| Item | Provider | Aylık (USD) |
|------|----------|-------------|
| Compute (3× t3.medium web + 2× t3.medium worker) | AWS | $200 |
| RDS Postgres (db.m5.large + replica) | AWS | $250 |
| ElastiCache Redis (cache.t3.medium × 3) | AWS | $150 |
| S3 storage (5 TB) + transfer (500 GB/mo) | AWS | $200 |
| Secrets Manager (3000 secrets) | AWS | $1200 |
| Email (Resend, 100K/mo) | Resend | $35 |
| CDN + WAF | Cloudflare | $20 |
| Monitoring (Grafana Cloud free tier) | — | $0 |
| Error tracking (Sentry team) | Sentry | $26 |
| Domain | Cloudflare | $1 |
| Stripe fees (1000 × $29 × 2.9% + $0.30) | Stripe | ~$1140 |
| **TOTAL infra** | — | **~$2,222/ay** |

**Revenue** (1000 × $29) = $29,000/ay → gross margin ~92%.

Bu hesaplama V2.5 hedefi; V2 launch'ta 50-100 tenant beklenir.

## 11.14 Açık Sorular (SaaS Launch)

| Soru | Önerilen | Karar tetikleyici |
|------|---------|-------------------|
| Bedava plan kalıcı mı yoksa sadece trial mı? | 14 gün trial + Free indefinite (limited) | Pazar tepkisi |
| White-label option? | V2.5 Enterprise add-on | Müşteri talebi |
| Open-source self-host source code'u GitHub'da? | Evet — SSPL veya BSL lisans | "Source-available" güven |
| EU data residency? | V2.5 enterprise add-on | GDPR talep eden müşteri |
| Refund policy? | Pro-rated within 14 days | Standart SaaS practice |
| Affiliate program? | V2.5 | Pazarlama bütçesine göre |
| Annual discount? | 2 ay bedava (16.6% off) | Cash flow ihtiyacı |
