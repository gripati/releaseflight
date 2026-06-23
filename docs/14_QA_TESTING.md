# 14 — QA & Testing Strategy

Test piramidi, tenant isolation testing zorunluluğu, ve `anthropics/skills/webapp-testing` skill metodolojisinin Playwright entegrasyonu.

## 14.0 Test Felsefesi

1. **Test confidence, not coverage** — %100 coverage hayali; %80 + kritik path %100 yeterli
2. **Cross-tenant isolation = first-class test** — her endpoint için cross-tenant attack suite zorunlu
3. **Real upstream rarely** — sandbox Apple/Google + msw mocks; canlı API sadece nightly e2e
4. **Visual regression matters** — UI'da pixel drift = production bug
5. **Determinism** — `test.skip(true, "flaky")` ban; flaky test fix first
6. **Speed** — unit < 100ms, integration < 5s, e2e < 60s per test

## 14.1 Test Piramidi

```
                         ┌──────────────┐
                         │   Manual     │   beta / dogfooding (sürekli)
                         │   QA         │
                         └──────────────┘
                       ┌──────────────────┐
                       │     E2E          │   ~30 tests (kritik user journeys)
                       │  (Playwright)    │   nightly + pre-release
                       └──────────────────┘
                  ┌─────────────────────────────┐
                  │      Integration            │   ~150 tests (per adapter)
                  │   (Vitest + msw + DB)       │   PR'da çalışır
                  └─────────────────────────────┘
              ┌───────────────────────────────────────┐
              │             Unit                      │   ~600 tests
              │   (Vitest, pure functions)            │   PR'da çalışır
              └───────────────────────────────────────┘

Visual regression (Percy / Playwright snapshot): ~50 page/component snapshots, weekly
Load tests (k6): 5 senaryo, V1.5'te aylık
Chaos tests: 3 ayda bir game day
Security: Pentest 6 ayda bir + bug bounty (V2)
```

## 14.2 Unit Tests (Vitest)

### 14.2.1 Hedef

Saf fonksiyonlar:
- `packages/core/src/locale/*` (locale converters)
- `packages/core/src/validation/*` (char limits, dimension specs)
- `packages/core/src/crypto/*` (JWT, MD5)
- `packages/core/src/adapters/*/types/*` (parsers, normalizers)
- `packages/core/src/orchestrators/MasterJsonImporter.ts` (logic)

### 14.2.2 Örnek

```ts
// packages/core/src/locale/__tests__/google.test.ts
import { toGooglePlayLocale, isGooglePlaySupported } from "../google";

describe("Google Play locale conversion", () => {
  test.each([
    ["en", "en-US"],
    ["en-US", "en-US"],
    ["tr", "tr-TR"],
    ["he", "iw-IL"],          // KRİTİK: Hebrew tuzağı
    ["he-IL", "iw-IL"],
    ["zh-Hans", "zh-CN"],
    ["zh-Hant", "zh-TW"],
    ["es-MX", "es-419"],      // Latin America
    ["fr-CH", "fr-CH"],       // unsupported, return as-is for caller to handle
  ])("toGooglePlayLocale(%s) → %s", (input, expected) => {
    expect(toGooglePlayLocale(input)).toBe(expected);
  });

  test("isGooglePlaySupported recognizes all 77 official codes", () => {
    expect(isGooglePlaySupported("iw-IL")).toBe(true);
    expect(isGooglePlaySupported("he-IL")).toBe(false);  // raw he-IL değil!
    expect(isGooglePlaySupported("fr-CH")).toBe(false);
  });
});
```

### 14.2.3 Coverage Hedefi

```yaml
# vitest.config.ts
coverage: {
  provider: "v8",
  thresholds: {
    "packages/core/src/locale/": { lines: 95, branches: 95 },
    "packages/core/src/validation/": { lines: 95 },
    "packages/core/src/crypto/": { lines: 100 },         // crypto = no excuse
    "packages/core/src/adapters/": { lines: 80 },
    "packages/core/src/orchestrators/": { lines: 85 },
    "apps/web/src/lib/": { lines: 75 },
    // Genel:
    lines: 80, branches: 75, functions: 80, statements: 80,
  },
  exclude: ["**/*.d.ts", "**/types/**", "**/__tests__/fixtures/**"],
}
```

CI fail if coverage düşerse.

## 14.3 Integration Tests (Vitest + msw + Postgres)

### 14.3.1 Adapter Tests (Apple/Google)

Real-world API responses fixture'larıyla:

```ts
// packages/core/src/adapters/apple/__tests__/AppleScreenshots.test.ts
import { setupServer } from "msw/node";
import { http, HttpResponse } from "msw";
import { AppleScreenshots } from "../AppleScreenshots";
import reserveResponse from "./fixtures/apple-reserveScreenshot-response.json";

const server = setupServer(
  http.post("https://api.appstoreconnect.apple.com/v1/appScreenshots", () =>
    HttpResponse.json(reserveResponse)
  ),
  http.put("https://s3.us-east-1.amazonaws.com/*", () => new HttpResponse(null, { status: 200 })),
  http.patch("https://api.appstoreconnect.apple.com/v1/appScreenshots/:id", () =>
    HttpResponse.json({ data: { id: "abc-123", attributes: { assetDeliveryState: { state: "COMPLETE" }}}})
  ),
);

beforeAll(() => server.listen());
afterAll(() => server.close());

describe("AppleScreenshots.uploadScreenshot", () => {
  test("happy path: reserve → put chunks → commit", async () => {
    const adapter = new AppleScreenshots(client);
    const result = await adapter.uploadScreenshot({
      storeAppId: "123",
      versionId: "v1",
      canonicalLocale: "en-US",
      displayType: "APP_IPHONE_65",
      filePath: "/tmp/test.png",
      fileName: "test.png",
    });
    expect(result.screenshotId).toBe("abc-123");
    expect(result.state).toBe("PROCESSING");
  });

  test("S3 upload fail → cleanup orphan reservation", async () => {
    server.use(
      http.put("https://s3.us-east-1.amazonaws.com/*", () => new HttpResponse("Forbidden", { status: 403 })),
    );
    const deleteHandler = vi.fn();
    server.use(http.delete("https://api.appstoreconnect.apple.com/v1/appScreenshots/:id", deleteHandler));

    await expect(adapter.uploadScreenshot(...)).rejects.toThrow("S3 upload failed");
    expect(deleteHandler).toHaveBeenCalled();  // cleanup zorunlu
  });

  test("chunked upload — 3 operations", async () => {
    server.use(
      http.post("https://api.appstoreconnect.apple.com/v1/appScreenshots", () =>
        HttpResponse.json({ data: { id: "abc", attributes: { uploadOperations: [
          { method: "PUT", url: "https://s3/.../?part=1", offset: 0, length: 1000000, requestHeaders: [...] },
          { method: "PUT", url: "https://s3/.../?part=2", offset: 1000000, length: 1000000, requestHeaders: [...] },
          { method: "PUT", url: "https://s3/.../?part=3", offset: 2000000, length: 500000, requestHeaders: [...] },
        ]}}})
      ),
    );
    let putCount = 0;
    server.use(http.put("https://s3.us-east-1.amazonaws.com/*", () => { putCount++; return new HttpResponse(); }));
    await adapter.uploadScreenshot(...);
    expect(putCount).toBe(3);
  });
});
```

### 14.3.2 Repository Tests (Prisma + Postgres)

`testcontainers-node` ile her test ephemeral Postgres:

```ts
// packages/db/src/__tests__/repos/app.test.ts
import { PostgreSqlContainer, StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PrismaClient } from "@prisma/client";

let container: StartedPostgreSqlContainer;
let prisma: PrismaClient;

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine").start();
  process.env.DATABASE_URL = container.getConnectionUri();
  await runMigrations(container.getConnectionUri());
  prisma = new PrismaClient();
}, 60_000);

afterAll(async () => {
  await prisma.$disconnect();
  await container.stop();
});

beforeEach(async () => {
  await prisma.$executeRaw`TRUNCATE "App", "Tenant", "User", "TenantMember" CASCADE`;
});

describe("App repository (tenant-scoped)", () => {
  test("create requires tenantId", async () => {
    await expect(
      prisma.app.create({ data: { platform: "IOS", bundleId: "com.foo", appName: "Foo" } as any })
    ).rejects.toThrow();
  });

  test("composite unique [tenantId, platform, bundleId] enforced", async () => {
    const tenant = await prisma.tenant.create({ data: { slug: "t1", name: "T1" }});
    await prisma.app.create({ data: { tenantId: tenant.id, platform: "IOS", bundleId: "com.foo", appName: "Foo", ... }});
    await expect(
      prisma.app.create({ data: { tenantId: tenant.id, platform: "IOS", bundleId: "com.foo", appName: "Dupe", ... }})
    ).rejects.toThrow(/Unique constraint/);
  });
});
```

### 14.3.3 RLS Tests (KRİTİK)

```ts
// packages/db/src/__tests__/rls.test.ts
import { tenantStorage } from "../tenantContext";

describe("Row-Level Security — Tenant Isolation", () => {
  let tenantA: Tenant, tenantB: Tenant, appA: App, appB: App;

  beforeAll(async () => {
    tenantA = await prisma.tenant.create({ data: { slug: "ta", name: "A" }});
    tenantB = await prisma.tenant.create({ data: { slug: "tb", name: "B" }});
    appA = await prismaAsRoot.app.create({ data: { tenantId: tenantA.id, ..., bundleId: "com.a" }});
    appB = await prismaAsRoot.app.create({ data: { tenantId: tenantB.id, ..., bundleId: "com.b" }});
  });

  test("Tenant A cannot see Tenant B's apps", async () => {
    await tenantStorage.run({ tenantId: tenantA.id, userId: "u1", role: "OWNER" }, async () => {
      const apps = await prisma.app.findMany();
      expect(apps.map(a => a.id)).toEqual([appA.id]);
      expect(apps).not.toContainEqual(expect.objectContaining({ id: appB.id }));
    });
  });

  test("Tenant A cannot read App B by direct ID", async () => {
    await tenantStorage.run({ tenantId: tenantA.id, userId: "u1", role: "OWNER" }, async () => {
      const app = await prisma.app.findUnique({ where: { id: appB.id }});
      expect(app).toBeNull();
    });
  });

  test("Tenant A cannot update App B", async () => {
    await tenantStorage.run({ tenantId: tenantA.id, userId: "u1", role: "OWNER" }, async () => {
      // RLS denies; result: 0 rows affected, treated as not-found by Prisma
      await expect(
        prisma.app.update({ where: { id: appB.id }, data: { appName: "HACKED" }})
      ).rejects.toThrow();
    });
    // Re-read from root to verify
    const fresh = await prismaAsRoot.app.findUnique({ where: { id: appB.id }});
    expect(fresh.appName).not.toBe("HACKED");
  });

  test("Tenant A cannot delete App B", async () => {
    await tenantStorage.run({ tenantId: tenantA.id, userId: "u1", role: "OWNER" }, async () => {
      await expect(prisma.app.delete({ where: { id: appB.id }})).rejects.toThrow();
    });
  });

  test("Tenant A cannot INSERT with wrong tenantId (RLS WITH CHECK)", async () => {
    await tenantStorage.run({ tenantId: tenantA.id, userId: "u1", role: "OWNER" }, async () => {
      // Tenant A tries to create app for Tenant B
      await expect(
        prisma.app.create({ data: { tenantId: tenantB.id, platform: "IOS", bundleId: "com.evil", appName: "Evil", ...}})
      ).rejects.toThrow();
    });
  });

  test("No-tenant-context query fails closed", async () => {
    // Outside tenantStorage.run → app.current_tenant is unset → RLS denies
    await expect(prisma.app.findMany()).rejects.toThrow();
    // Veya en azından 0 row döner (set kontrolüne göre)
  });
});
```

**Her tenant-scoped tablo için** bu suite yazılır. **Automated generator script** ekleyebiliriz:

```bash
# packages/db/scripts/gen-rls-tests.ts
# Schema'dan tenantId'li tüm modelleri tara, her biri için yukarıdaki test'leri otomatik üret
```

## 14.4 E2E Tests (Playwright via webapp-testing skill)

`anthropics/skills/webapp-testing` skill metodolojisi:

- **Reconnaissance-then-action**: önce DOM inspect, sonra selector ile aksiyon
- **`page.wait_for_load_state('networkidle')`** kritik (dynamic apps için)
- **`with_server.py`** helper script ile multi-server lifecycle

### 14.4.1 E2E Test Yapısı

```
e2e/
├── playwright.config.ts
├── fixtures/
│   ├── apple-sandbox-cred.p8         # gerçek Apple sandbox key (gitignore)
│   ├── google-sandbox-cred.json
│   ├── master-json-fixture.json
│   └── screenshots/
│       └── iphone-65-test.png
├── helpers/
│   ├── auth.ts                       # login as test user
│   ├── tenant.ts                     # create test tenant, switch
│   ├── seed.ts                       # seed test data
│   └── apple-sandbox.ts              # cleanup sandbox apps post-test
├── critical-paths/
│   ├── 01-login.spec.ts
│   ├── 02-connect-ios-app.spec.ts
│   ├── 03-push-metadata-single-locale.spec.ts
│   ├── 04-push-metadata-bulk.spec.ts
│   ├── 05-upload-screenshot.spec.ts
│   ├── 06-import-master-json.spec.ts
│   ├── 07-credential-rotate.spec.ts
│   ├── 08-invite-member.spec.ts
│   ├── 09-tenant-switch.spec.ts
│   ├── 10-signup-saas.spec.ts
│   └── 11-billing-upgrade.spec.ts
├── tenant-isolation/
│   ├── 01-cross-tenant-api-blocked.spec.ts
│   ├── 02-cross-tenant-url-access.spec.ts
│   ├── 03-cross-tenant-cache-isolated.spec.ts
│   └── 04-cross-tenant-jobs-isolated.spec.ts
├── visual-regression/
│   └── *.spec.ts                     # snapshot tests
└── load/
    └── *.k6.ts                       # k6 scripts
```

### 14.4.2 Critical Path Örneği

```ts
// e2e/critical-paths/03-push-metadata-single-locale.spec.ts
import { test, expect } from "@playwright/test";
import { loginAsTestOwner, seedConnectedApp } from "../helpers";

test.describe("Push metadata - single locale (iOS)", () => {
  let appId: string;

  test.beforeAll(async ({ browser }) => {
    const context = await browser.newContext();
    appId = await seedConnectedApp(context, { platform: "iOS", bundleId: "com.test.app" });
  });

  test("user can edit en-US, save locally, push to Apple sandbox", async ({ page }) => {
    // 1. Login
    await loginAsTestOwner(page);

    // 2. Navigate (test slug = "default")
    await page.goto(`/t/default/apps/${appId}/metadata`);
    await page.waitForLoadState("networkidle");

    // 3. Reconnaissance: ensure locale rail loaded
    await expect(page.locator('[data-testid="locale-rail"]')).toBeVisible();
    const enUsChip = page.locator('[data-testid="locale-chip-en-US"]');
    await expect(enUsChip).toBeVisible();

    // 4. Action: select locale + edit description
    await enUsChip.click();
    const descArea = page.locator('textarea[name="description"]');
    await descArea.fill("TEST DESCRIPTION " + Date.now());

    // 5. Verify dirty state visible
    await expect(page.locator('[data-testid="unsaved-banner"]')).toBeVisible();

    // 6. Save locally
    await page.click('button:has-text("Save locally")');
    await expect(page.locator(".toast-success")).toContainText("Saved");

    // 7. Click Push → Preview (DiffSheet açılır)
    await page.click('button:has-text("Push to store")');
    await page.click('[role="menuitem"]:has-text("Preview changes")');
    await expect(page.locator('[role="dialog"]:has-text("Preview push")')).toBeVisible();

    // 8. Confirm
    await page.click('button:has-text("Confirm push")');

    // 9. Wait for job complete (SSE-driven)
    await expect(page.locator('[data-testid="job-progress"]')).toBeVisible();
    await page.waitForSelector('[data-testid="job-status-completed"]', { timeout: 60_000 });

    // 10. Verify dirty cleared
    await expect(page.locator('[data-testid="unsaved-banner"]')).not.toBeVisible();
  });
});
```

### 14.4.3 webapp-testing Skill Helper Usage

Multi-server test setup (web + worker):

```bash
# Lokal'de e2e çalıştırırken
python e2e/scripts/with_server.py \
  --server "pnpm --filter @marquee/web dev" --port 3000 \
  --server "pnpm --filter @marquee/worker dev" --port 4000 \
  -- npx playwright test
```

Veya CI'da (Docker Compose):
```yaml
# .github/workflows/e2e.yml
- name: Start services
  run: docker compose -f docker-compose.test.yml up -d --wait
- name: Run Playwright
  run: pnpm exec playwright test
```

### 14.4.4 Reconnaissance Pattern (Skill methodology)

Dinamik UI testing'de zorunlu:

```ts
test("metadata editor — discover form fields dynamically", async ({ page }) => {
  await page.goto(`/t/default/apps/${appId}/metadata`);

  // STEP 1: Wait for full load
  await page.waitForLoadState("networkidle");

  // STEP 2: Inspect — DOM screenshot for debugging
  if (process.env.DEBUG) await page.screenshot({ path: "/tmp/inspect-metadata.png", fullPage: true });

  // STEP 3: Discover all editable fields
  const fields = await page.locator("textarea, input[type='text']").all();
  console.log(`Found ${fields.length} editable fields`);

  // STEP 4: Discover all character counters
  const counters = await page.locator("[data-testid^='char-counter-']").all();
  const counterIds = await Promise.all(counters.map(c => c.getAttribute("data-testid")));
  console.log("Character counters:", counterIds);

  // STEP 5: Act
  // ... (use discovered selectors)
});
```

## 14.5 Tenant Isolation E2E (KRİTİK suite)

### 14.5.1 Cross-Tenant IDOR

```ts
// e2e/tenant-isolation/01-cross-tenant-api-blocked.spec.ts
test.describe("Cross-tenant data access blocked", () => {
  let tenantA: TenantContext, tenantB: TenantContext, appB_id: string;

  test.beforeAll(async ({ browser }) => {
    tenantA = await createTestTenant(browser, "ta-iso-test");
    tenantB = await createTestTenant(browser, "tb-iso-test");
    appB_id = await seedAppInTenant(tenantB, { bundleId: "com.tenant-b.secret" });
  });

  test("Tenant A user cannot fetch App B via API", async ({ request }) => {
    const res = await request.get(`/api/v1/apps/${appB_id}`, {
      headers: { Cookie: tenantA.sessionCookie },
    });
    expect(res.status()).toBe(404);   // not 403 — biz "yok" diyoruz, var olduğunu sızdırmayalım
  });

  test("Tenant A cannot read App B's localizations", async ({ request }) => {
    const res = await request.get(`/api/v1/apps/${appB_id}/metadata`, {
      headers: { Cookie: tenantA.sessionCookie },
    });
    expect([403, 404]).toContain(res.status());
  });

  test("Tenant A cannot push to App B", async ({ request }) => {
    const res = await request.post(`/api/v1/apps/${appB_id}/metadata/push`, {
      headers: { Cookie: tenantA.sessionCookie },
      data: { locales: ["en-US"] },
    });
    expect([403, 404]).toContain(res.status());
  });

  test("Tenant A cannot delete App B", async ({ request }) => {
    const res = await request.delete(`/api/v1/apps/${appB_id}`, {
      headers: { Cookie: tenantA.sessionCookie },
    });
    expect([403, 404]).toContain(res.status());
  });

  test("Tenant A cannot upload screenshot to App B", async ({ request }) => {
    const res = await request.post(`/api/v1/apps/${appB_id}/screenshots/upload`, {
      headers: { Cookie: tenantA.sessionCookie },
      multipart: { file: fs.createReadStream("e2e/fixtures/screenshots/iphone-65-test.png") },
    });
    expect([403, 404]).toContain(res.status());
  });

  test("Tenant A cannot fetch Tenant B's audit log", async ({ request }) => {
    const res = await request.get(`/api/v1/audit`, {
      headers: { Cookie: tenantA.sessionCookie },
      params: { tenantId: tenantB.id },   // saldırgan ?tenantId= ile push etse bile
    });
    // Response sadece tenant A'nın event'leri olmalı; tenantId override silently ignored
    const data = await res.json();
    expect(data.events.every((e: any) => e.tenantId === tenantA.id)).toBe(true);
  });
});
```

### 14.5.2 URL-Based Cross-Tenant Access

```ts
test("Tenant A user cannot access /t/tenant-b/* URLs", async ({ page }) => {
  await loginAs(page, tenantA);
  await page.goto(`/t/${tenantB.slug}/dashboard`);
  // Expect redirect to access-denied or own tenant
  await page.waitForURL(new RegExp(`/t/${tenantA.slug}|/access-denied`));
});

test("Tenant slug spoofing via header", async ({ request }) => {
  const res = await request.get(`/api/v1/apps`, {
    headers: {
      Cookie: tenantA.sessionCookie,
      "x-tenant-id": tenantB.id,   // attempt to override
    },
  });
  // Middleware ignores user-supplied header; uses session.activeTenantId
  const data = await res.json();
  expect(data.apps.every((a: any) => a.tenantId === tenantA.id)).toBe(true);
});
```

### 14.5.3 Cache & Queue Isolation

```ts
test("Redis cache keys don't leak across tenants", async () => {
  await tenantStorage.run({ tenantId: tenantA.id, userId: "u" }, async () => {
    await cache.set("foo", "tenantA-value");
  });
  await tenantStorage.run({ tenantId: tenantB.id, userId: "u" }, async () => {
    const value = await cache.get("foo");
    expect(value).toBeNull();   // tenantB key başka
  });
});

test("Job started by Tenant A cannot be cancelled by Tenant B", async ({ request }) => {
  const jobA = await enqueueTestJob(tenantA);
  const res = await request.post(`/api/v1/jobs/${jobA.id}/cancel`, {
    headers: { Cookie: tenantB.sessionCookie },
  });
  expect([403, 404]).toContain(res.status());
});
```

## 14.6 Visual Regression (Percy / Playwright snapshot)

V1.5'te eklenir.

```ts
// e2e/visual-regression/metadata-page.spec.ts
test("MetadataPage visual regression — en-US selected", async ({ page }) => {
  await loginAndSeedApp(page);
  await page.goto(`/t/default/apps/${appId}/metadata`);
  await page.waitForLoadState("networkidle");
  // disable animations for stable snapshot
  await page.addStyleTag({ content: "* { animation: none !important; transition: none !important; }" });
  await expect(page).toHaveScreenshot("metadata-en-us.png", {
    fullPage: true,
    maxDiffPixels: 100,
  });
});
```

Snapshot baseline'lar `e2e/visual-regression/__screenshots__/` — git LFS'te (büyük binary).

PR'da fark varsa Percy / Playwright report'ta side-by-side görüntü; reviewer onaylayarak baseline günceller.

## 14.7 Load Testing (k6)

```js
// e2e/load/metadata-push-burst.k6.js
import http from "k6/http";
import { check, sleep } from "k6";

export const options = {
  scenarios: {
    burst: {
      executor: "ramping-vus",
      stages: [
        { duration: "30s", target: 20 },     // ramp to 20 VUs
        { duration: "2m", target: 20 },      // hold
        { duration: "30s", target: 0 },
      ],
    },
  },
  thresholds: {
    http_req_duration: ["p(99)<500"],         // SLO target
    http_req_failed: ["rate<0.01"],
  },
};

const SESSION = open("./fixtures/test-session-cookie.txt");

export default function () {
  const res = http.post("http://localhost:3000/api/v1/apps/test-app/metadata/push", JSON.stringify({
    locales: ["en-US"],
  }), {
    headers: { "Content-Type": "application/json", "Cookie": SESSION },
  });
  check(res, { "is 202": (r) => r.status === 202 });
  sleep(1);
}
```

Senaryolar:
1. **Single tenant burst** — 100 user × 5 dakika push
2. **Multi-tenant fairness** — 10 tenant × 10 user simultaneous
3. **Screenshot upload burst** — 50 concurrent uploads, large files
4. **Master JSON import stress** — 200 locale × 5 simultaneous
5. **Sustained baseline** — 24 saat at expected daily load

Çıktı: Grafana load test dashboard, p99 chart.

## 14.8 Security Testing

### 14.8.1 Static Analysis

CI'da:
- `snyk test` — vulnerable dependencies
- `eslint-plugin-security` — common pitfalls
- `gitleaks` — secret commit'leri yakala
- `semgrep` (V1.5) — pattern-based bug finder

### 14.8.2 Dynamic Analysis

- **OWASP ZAP** automated weekly scan (CI scheduled job)
- **Burp Suite** manual quarterly review
- **External pentest** 6 ayda bir (V1.5+)
- **Bug bounty** V2 (HackerOne)

### 14.8.3 Secret Scan

Pre-commit hook:
```bash
# .githooks/pre-commit
#!/bin/bash
gitleaks protect --staged --verbose
```

CI gates: `gitleaks detect --report-format sarif`.

## 14.9 Accessibility Testing

### 14.9.1 Automated (axe-core)

```ts
// e2e/a11y/*.spec.ts
import { test, expect } from "@playwright/test";
import AxeBuilder from "@axe-core/playwright";

test("Dashboard page has no a11y violations", async ({ page }) => {
  await loginAndGoTo(page, "/t/default/dashboard");
  const results = await new AxeBuilder({ page }).analyze();
  expect(results.violations).toEqual([]);
});
```

Her sayfa için a11y test'i. CI fail if violation.

### 14.9.2 Manual

- **Keyboard navigation**: tüm route'lar tab-traversal
- **NVDA** (Windows) screen reader test, MVP öncesi 1 saat
- **VoiceOver** (macOS) screen reader test
- **Color blindness simulator** Chrome DevTools, 3 mod (deuteranopia, protanopia, tritanopia)

## 14.10 Browser Matrix Testing

| Browser | V1 | V1.5 | V2 |
|---------|----|----|----|
| Chrome (last 2) | ✓ | ✓ | ✓ |
| Firefox (last 2) | ✓ | ✓ | ✓ |
| Safari 17+ | ✓ | ✓ | ✓ |
| Edge (last 2) | — | ✓ | ✓ |
| Mobile Safari | — | — | read-only V2 |
| Mobile Chrome | — | — | read-only V2 |

Playwright cross-browser: `projects: [{ name: "chromium" }, { name: "firefox" }, { name: "webkit" }]`.

CI matrix run per PR (3 paralel).

## 14.11 Test Data Management

### 14.11.1 Fixtures

```
e2e/fixtures/
├── tenants/
│   ├── test-tenant-a.json
│   └── test-tenant-b.json
├── apps/
│   ├── ios-app-ready.json
│   └── android-app-prep.json
├── master-json/
│   └── word-stack-35-locales.json
├── screenshots/
│   └── iphone-65-test-1284x2778.png
├── credentials/
│   ├── apple-sandbox.p8.enc          # GPG encrypted
│   └── google-sandbox.json.enc
└── api-responses/
    ├── apple/
    │   ├── reserveScreenshot.json
    │   └── ...
    └── google/
        └── ...
```

Sandbox credentials encrypted; CI'da `GPG_PASSPHRASE` secret ile decrypt.

### 14.11.2 Apple/Google Sandbox

- **Apple**: dedicated sandbox app at App Store Connect, ayrı bundle ID `com.gripati.gp-test`
- **Google**: dedicated sandbox developer account + test app

Sandbox app'larında **post-test cleanup**:
```ts
afterAll(async () => {
  await deleteAllVersionLocalizations(SANDBOX_APP_ID);   // sandbox kirlilik temizle
  await deleteAllScreenshots(SANDBOX_APP_ID);
});
```

### 14.11.3 Ephemeral Test Database

Vitest integration tests testcontainer; e2e tests Docker Compose dedicated DB:
```yaml
services:
  db-test:
    image: postgres:16-alpine
    tmpfs: /var/lib/postgresql/data       # in-memory için, hızlı + ephemeral
    environment:
      POSTGRES_PASSWORD: test
```

## 14.12 CI Pipeline

`.github/workflows/`:

### 14.12.1 PR Pipeline (`pr.yml`)

Trigger: pull_request

```yaml
jobs:
  lint:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
      - uses: pnpm/action-setup@v3
      - uses: actions/setup-node@v4
        with: { node-version: 22, cache: pnpm }
      - run: pnpm install --frozen-lockfile
      - run: pnpm lint
      - run: pnpm typecheck

  unit:
    runs-on: ubuntu-latest
    steps:
      - # setup
      - run: pnpm test:unit --coverage
      - uses: codecov/codecov-action@v4

  integration:
    runs-on: ubuntu-latest
    services:
      postgres:
        image: postgres:16-alpine
        env: { POSTGRES_PASSWORD: test }
        ports: ["5432:5432"]
      redis:
        image: redis:7-alpine
        ports: ["6379:6379"]
    steps:
      - # setup
      - run: pnpm db:migrate:deploy
      - run: pnpm test:integration

  e2e-mock:
    runs-on: ubuntu-latest
    steps:
      - # setup full stack via docker-compose
      - run: pnpm exec playwright install --with-deps
      - run: pnpm test:e2e --grep "@critical"      # @critical tagged only on PR

  security:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm audit --prod
      - run: snyk test --severity-threshold=high
      - uses: gitleaks/gitleaks-action@v2

  bundle-size:
    runs-on: ubuntu-latest
    steps:
      - run: pnpm build
      - run: pnpm bundle-size:check
```

### 14.12.2 Nightly Pipeline (`nightly.yml`)

Trigger: schedule (02:00 UTC daily)

```yaml
jobs:
  e2e-full:
    # Full e2e suite (not just @critical)
    # Including Apple/Google sandbox tests
  visual-regression:
    # Percy snapshots
  load-test:
    # k6 baseline scenario
  security-zap:
    # OWASP ZAP scan
```

### 14.12.3 Release Pipeline (`release.yml`)

Trigger: tag push `v*.*.*`

```yaml
jobs:
  build:
    # Build Docker images
    # Push to registry
  deploy-staging:
    # Auto-deploy to staging
    # Run smoke tests
  manual-prod-approve:
    # GitHub Environment with required reviewer
  deploy-prod:
    # Deploy to production
    # Verify SLO post-deploy
  rollback-on-fail:
    # Auto-rollback if SLO burn detected within 15 min
```

## 14.13 Test Naming & Organization

### 14.13.1 Naming Convention

```
describe("[Subject]") {
  describe("[Sub-feature or condition]") {
    test("[behavior expected when X]") {}
  }
}
```

Örnekler:
- `AppleScreenshots > uploadScreenshot > happy path: reserve → put chunks → commit`
- `AppleScreenshots > uploadScreenshot > S3 upload fail → cleanup orphan reservation`
- `MetadataPage > push action > shows DiffSheet before sending`

### 14.13.2 Tags

```ts
test("...", { tag: ["@critical", "@e2e", "@tenant-isolation"] }, async () => {});
```

CI filter:
- PR: `--grep @critical`
- Nightly: tüm tag'ler

### 14.13.3 Skip Discipline

`test.skip()` veya `test.fixme()` kullanımı **ZORUNLU**:
- Issue link açıklamasında
- 7 gün içinde fix veya silinmeli (CI uyarısı)

```ts
test.fixme("flaky — see #1234", async () => {});
```

## 14.14 Performance Test Budget

Test suite execution:
- Unit: < 30 saniye full run
- Integration: < 3 dakika full run
- E2E @critical: < 5 dakika
- E2E full: < 15 dakika
- Visual regression: < 5 dakika

CI total: PR pipeline < 10 dakika hedef.

## 14.15 Coverage Reports

- Codecov.io integration → PR comment ile diff
- Min coverage threshold (Vitest config) PR'da CI gate
- Per-package coverage breakdown
- Quarterly coverage review: hangi alanlar kör nokta?

## 14.16 Bug Triage Process

1. **Discover** — user report, alert, CI fail, internal QA
2. **Classify** severity (SEV1-4, bkz. `13_STABILITY_OPS.md`)
3. **Reproduce** — write failing test FIRST (TDD bug fix)
4. **Fix** — minimal change to make test pass
5. **Add regression test** — testify the fix
6. **Document** — `docs/known-issues.md` (resolved section)

Critical bug fix workflow:
- Hotfix branch direkt main'den
- Pre-merge: 2 reviewer + e2e full pass
- Post-deploy: 15 dakika SLO monitoring
- Post-mortem 48 saat içinde

## 14.17 Manual QA Checklist (Pre-Release)

Her release (V1.0, V1.1, V1.5, V2.0) öncesi:

- [ ] Critical user paths (10 test) manuel walkthrough
- [ ] Browser cross-check (Chrome + Firefox + Safari)
- [ ] Mobile read-only check (V1.5+)
- [ ] A11y screen reader spot-check
- [ ] i18n: Türkçe, Arabic RTL, Japanese characters görünüyor
- [ ] Empty states: yeni hesap deneyimi
- [ ] Error states: network kapalı simulation
- [ ] Performance: Lighthouse > 90 manuel
- [ ] Multi-tenant: 2 tab 2 farklı tenant — isolation OK
- [ ] Theme: light + dark toggle smooth
- [ ] Keyboard: Cmd+K çalışıyor
- [ ] Build artifact size: bundle analyzer review

## 14.18 Test Documentation

`docs/testing/`:
- `running-locally.md` — yeni geliştirici nasıl test çalıştırır
- `writing-tests.md` — naming, fixtures, helpers
- `apple-sandbox-setup.md` — sandbox app nasıl yaratılır
- `google-sandbox-setup.md`
- `flaky-test-policy.md` — keşfedilen flaky'ler nasıl handle edilir
- `coverage-targets.md`

## 14.19 V1 Test Acceptance Criteria

- [ ] Unit coverage > 80%
- [ ] Integration coverage > 70%
- [ ] E2E @critical 30 senaryo, hepsi green
- [ ] Tenant isolation suite full pass
- [ ] A11y axe-core no violations
- [ ] CI PR pipeline < 10 dakika
- [ ] Nightly e2e < 30 dakika
- [ ] Sandbox cleanup otomatik (sandbox app temiz)
- [ ] Load test baseline scenario p99 < 500ms
- [ ] Visual regression baseline kayıtlı
- [ ] Coverage report PR'da görünür (Codecov)
- [ ] All flaky tests fixed or deleted (< 0.5% retry rate)
