/**
 * Row-Level Security integration tests — CRITICAL for tenant isolation.
 *
 * Unlike the previous version, these exercise the REAL exported `prisma`
 * client (the production `$extends` tenant-context wrapper in ../prisma),
 * NOT a hand-rolled `$use` mock. They run against a real Postgres with the
 * actual `prisma/rls.sql` policies applied, and the client connects as the
 * non-superuser `gp_app` role so RLS is genuinely ENFORCED (a superuser
 * connection would bypass RLS and make these tests meaningless).
 *
 * This is exactly the path the web app and the background worker use. If any
 * of these tests start failing, STOP — it likely means a cross-tenant leak.
 *
 * Regression guard: with the old wrapper (which ran the query on a different
 * pooled connection than the SET LOCAL), every scoped read returned zero rows
 * (fail-closed) — so the "sees only its own" assertions below would fail.
 *
 * Requires Docker (testcontainers spins up Postgres 16).
 */
import { afterAll, beforeAll, beforeEach, describe, expect, test } from "vitest";
import { PostgreSqlContainer, type StartedPostgreSqlContainer } from "@testcontainers/postgresql";
import { PrismaClient } from "@prisma/client";
import { execSync } from "node:child_process";
import path from "node:path";
import { tenantStorage } from "../tenantContext";

const TENANT_A = "11111111-1111-4111-8111-111111111111";
const TENANT_B = "22222222-2222-4222-8222-222222222222";
const USER_ID = "33333333-3333-4333-8333-333333333333";
const CRED_A = "44444444-4444-4444-8444-444444444444";
const CRED_B = "55555555-5555-4555-8555-555555555555";
const APP_A = "44444444-aaaa-4444-8444-444444444444";
const APP_B = "55555555-bbbb-4555-8555-555555555555";
const APP_CONN_A = "66666666-6666-4666-8666-666666666666";

const APP_DB_PASSWORD = "gp_app_test_pw";

let container: StartedPostgreSqlContainer;
/** Superuser connection — used only for setup, seeding and out-of-band assertions. */
let bypass: PrismaClient;
/** The REAL production client from ../prisma, connecting as the non-superuser gp_app. */
let prisma: PrismaClient;
/** The atomic, tenant-scoped transaction helper from ../prisma. */
let tenantTransaction: <T>(fn: (tx: PrismaClient) => Promise<T>) => Promise<T>;
/** Boot guard asserting FORCE ROW LEVEL SECURITY on every tenant table. */
let assertTenantTablesForceRls: () => Promise<void>;

/** Swap the userinfo of a Postgres URL to connect as the gp_app role. */
function asGpApp(url: string): string {
  const u = new URL(url);
  u.username = "gp_app";
  u.password = APP_DB_PASSWORD;
  return u.toString();
}

beforeAll(async () => {
  container = await new PostgreSqlContainer("postgres:16-alpine")
    .withDatabase("gp_test")
    .withUsername("gp")
    .withPassword("gp_test")
    .start();

  const adminUrl = container.getConnectionUri();
  const pkgRoot = path.join(__dirname, "../..");
  const adminEnv = { ...process.env, DATABASE_URL: adminUrl, DIRECT_URL: adminUrl };

  // 1) Apply the schema. This repo ships schema via `db push` (no migrations
  //    directory), so use that — NOT `migrate deploy`, which applies nothing.
  execSync("pnpm exec prisma db push --skip-generate --accept-data-loss", {
    cwd: pkgRoot,
    stdio: "inherit",
    env: adminEnv,
  });

  // 2) Apply the REAL RLS policies + create the non-superuser gp_app role.
  execSync("pnpm exec prisma db execute --file prisma/rls.sql --schema prisma/schema.prisma", {
    cwd: pkgRoot,
    stdio: "inherit",
    env: adminEnv,
  });

  bypass = new PrismaClient({ datasources: { db: { url: adminUrl } } });
  // gp_app is created without a password by rls.sql; set one for the test.
  await bypass.$executeRawUnsafe(`ALTER ROLE gp_app WITH PASSWORD '${APP_DB_PASSWORD}'`);

  // 3) Point the REAL prisma client at the non-superuser gp_app role, THEN
  //    import it so its singleton picks up this DATABASE_URL. Importing after
  //    setting env is essential — the client reads the URL at construction.
  const appUrl = asGpApp(adminUrl);
  process.env.DATABASE_URL = appUrl;
  process.env.DIRECT_URL = appUrl;
  const mod = (await import("../prisma")) as unknown as {
    prisma: PrismaClient;
    tenantTransaction: <T>(fn: (tx: PrismaClient) => Promise<T>) => Promise<T>;
    assertTenantTablesForceRls: () => Promise<void>;
  };
  prisma = mod.prisma;
  tenantTransaction = mod.tenantTransaction;
  assertTenantTablesForceRls = mod.assertTenantTablesForceRls;
}, 180_000);

afterAll(async () => {
  await prisma?.$disconnect();
  await bypass?.$disconnect();
  await container?.stop();
});

beforeEach(async () => {
  await bypass.$executeRawUnsafe(`
    TRUNCATE TABLE "AuditEvent", "Job", "Screenshot", "AppPreview", "AndroidImage",
      "AppConnection", "AppLocalization", "App", "Credential", "TenantMember",
      "Session", "User", "TenantSetting", "Subscription",
      "UsageRecord", "Tenant"
    RESTART IDENTITY CASCADE
  `);
  await bypass.tenant.createMany({
    data: [
      { id: TENANT_A, slug: "ta", name: "Tenant A" },
      { id: TENANT_B, slug: "tb", name: "Tenant B" },
    ],
  });
  await bypass.user.create({
    data: { id: USER_ID, email: "u@test.com", displayName: "U", status: "ACTIVE" },
  });
  await bypass.tenantMember.createMany({
    data: [
      { tenantId: TENANT_A, userId: USER_ID, role: "OWNER" },
      { tenantId: TENANT_B, userId: USER_ID, role: "OWNER" },
    ],
  });
  await bypass.credential.createMany({
    data: [
      { id: CRED_A, tenantId: TENANT_A, kind: "APPLE", name: "A", secretRef: "x", createdById: USER_ID },
      { id: CRED_B, tenantId: TENANT_B, kind: "APPLE", name: "B", secretRef: "y", createdById: USER_ID },
    ],
  });
  await bypass.app.createMany({
    data: [
      { id: APP_A, tenantId: TENANT_A, credentialId: CRED_A, platform: "ANDROID", bundleId: "com.test.a", appName: "App A", primaryLocale: "en-US", createdById: USER_ID },
      { id: APP_B, tenantId: TENANT_B, credentialId: CRED_B, platform: "ANDROID", bundleId: "com.test.b", appName: "App B", primaryLocale: "en-US", createdById: USER_ID },
    ],
  });
});

// IMPORTANT: the callback MUST await `fn()` *inside* the AsyncLocalStorage
// scope. A lazy thunk like `() => prisma.x.findMany()` returns the (not-yet-
// executed) PrismaPromise, which only runs after tenantStorage.run() exits —
// by then the tenant context is gone and the GUC is never set. This mirrors
// the production path (withTenantContext runs `async () => fn(ctx)`).
function asTenant<T>(tenantId: string, fn: () => Promise<T>): Promise<T> {
  return tenantStorage.run({ tenantId, userId: USER_ID, role: "OWNER", requestId: "t" }, async () => await fn());
}

describe("RLS (production prisma client) — tenant isolation", () => {
  test("a no-context query returns zero rows (fail closed)", async () => {
    const creds = await prisma.credential.findMany();
    expect(creds).toHaveLength(0);
  });

  test("each tenant sees ONLY its own credentials (proves the GUC reaches the query connection)", async () => {
    const a = await asTenant(TENANT_A, () => prisma.credential.findMany());
    expect(a.map((c) => c.id)).toEqual([CRED_A]);
    const b = await asTenant(TENANT_B, () => prisma.credential.findMany());
    expect(b.map((c) => c.id)).toEqual([CRED_B]);
  });

  test("a tenant cannot read another tenant's credential by direct id", async () => {
    const stolen = await asTenant(TENANT_A, () => prisma.credential.findUnique({ where: { id: CRED_B } }));
    expect(stolen).toBeNull();
  });

  test("a tenant cannot UPDATE another tenant's credential", async () => {
    const res = await asTenant(TENANT_A, () =>
      prisma.credential.updateMany({ where: { id: CRED_B }, data: { name: "HACKED" } }),
    );
    expect(res.count).toBe(0);
    const fresh = await bypass.credential.findUnique({ where: { id: CRED_B } });
    expect(fresh?.name).toBe("B");
  });

  test("a tenant cannot INSERT a row pointing at another tenant (WITH CHECK)", async () => {
    await asTenant(TENANT_A, async () => {
      await expect(
        prisma.credential.create({
          data: { tenantId: TENANT_B, kind: "APPLE", name: "INJECTED", secretRef: "z", createdById: USER_ID },
        }),
      ).rejects.toThrow();
    });
  });
});

describe("tenantTransaction — atomic + tenant-scoped multi-write", () => {
  test("writes inside the helper are tenant-scoped (the GUC reaches the tx connection)", async () => {
    await asTenant(TENANT_A, () =>
      tenantTransaction(async (tx) => {
        await tx.app.update({ where: { id: APP_A }, data: { appName: "Renamed A" } });
        await tx.appLocalization.upsert({
          where: { appId_locale: { appId: APP_A, locale: "en-US" } },
          create: { appId: APP_A, tenantId: TENANT_A, locale: "en-US", name: "loc" },
          update: { name: "loc" },
        });
      }),
    );
    const fresh = await bypass.app.findUnique({ where: { id: APP_A } });
    expect(fresh?.appName).toBe("Renamed A");
    const loc = await bypass.appLocalization.findFirst({ where: { appId: APP_A } });
    expect(loc?.name).toBe("loc");
  });

  test("a mid-batch failure rolls back the WHOLE transaction (atomicity)", async () => {
    await expect(
      asTenant(TENANT_A, () =>
        tenantTransaction(async (tx) => {
          await tx.app.update({ where: { id: APP_A }, data: { appName: "ShouldRollBack" } });
          // Cross-tenant INSERT violates the RLS WITH CHECK → throws → the
          // first update above must roll back with it.
          await tx.credential.create({
            data: { tenantId: TENANT_B, kind: "APPLE", name: "X", secretRef: "z", createdById: USER_ID },
          });
        }),
      ),
    ).rejects.toThrow();
    const fresh = await bypass.app.findUnique({ where: { id: APP_A } });
    expect(fresh?.appName).toBe("App A"); // unchanged — proves rollback
  });

  test("the helper cannot mutate another tenant's row (RLS still enforced)", async () => {
    await expect(
      asTenant(TENANT_A, () =>
        tenantTransaction(async (tx) => {
          await tx.app.update({ where: { id: APP_B }, data: { appName: "HACKED" } });
        }),
      ),
    ).rejects.toThrow();
    const fresh = await bypass.app.findUnique({ where: { id: APP_B } });
    expect(fresh?.appName).toBe("App B");
  });
});

describe("AuditEvent append-only (MARQ-022)", () => {
  const EVT = "77777777-7777-4777-8777-777777777777";

  test("gp_app CAN insert an audit event for its own tenant", async () => {
    await asTenant(TENANT_A, async () => {
      const created = await prisma.auditEvent.create({
        data: { tenantId: TENANT_A, action: "ins.test", outcome: "SUCCESS", userId: USER_ID },
      });
      expect(created.id).toBeTruthy();
    });
  });

  test("gp_app CANNOT update or delete audit events (REVOKE UPDATE, DELETE)", async () => {
    // Seed via the bypass/admin role.
    await bypass.auditEvent.create({
      data: { id: EVT, tenantId: TENANT_A, action: "seed.action", outcome: "SUCCESS", userId: USER_ID },
    });
    await asTenant(TENANT_A, async () => {
      await expect(
        prisma.auditEvent.update({ where: { id: EVT }, data: { action: "tampered" } }),
      ).rejects.toThrow();
      await expect(prisma.auditEvent.delete({ where: { id: EVT } })).rejects.toThrow();
    });
    // The row is untouched — the audit trail is immutable to the app role.
    const fresh = await bypass.auditEvent.findUnique({ where: { id: EVT } });
    expect(fresh?.action).toBe("seed.action");
  });
});

describe("assertTenantTablesForceRls (MARQ-002)", () => {
  test("passes when FORCE RLS is applied to every tenant table", async () => {
    await expect(assertTenantTablesForceRls()).resolves.toBeUndefined();
  });

  test("THROWS in production if a tenant table loses FORCE ROW LEVEL SECURITY", async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevOverride = process.env.MARQUEE_ALLOW_INSECURE_DB_ROLE;
    await bypass.$executeRawUnsafe('ALTER TABLE "Credential" NO FORCE ROW LEVEL SECURITY');
    try {
      process.env.NODE_ENV = "production";
      delete process.env.MARQUEE_ALLOW_INSECURE_DB_ROLE;
      await expect(assertTenantTablesForceRls()).rejects.toThrow(/Row-Level Security is NOT forced/i);
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevOverride !== undefined) process.env.MARQUEE_ALLOW_INSECURE_DB_ROLE = prevOverride;
      await bypass.$executeRawUnsafe('ALTER TABLE "Credential" FORCE ROW LEVEL SECURITY');
    }
  });
});

describe("RLS — AppConnection (secretRef holder; most security-sensitive new surface)", () => {
  // AppConnection rows carry the `secretRef` that the firebase-groups route
  // (apps/web/src/app/api/v1/apps/[id]/firebase-groups/route.ts) feeds straight
  // into the secret provider. A cross-tenant read here would hand tenant B a
  // pointer to tenant A's Firebase / Git / Android-keystore secret, so this
  // table MUST be tenant-isolated. These mirror the Credential tests above.
  const SECRET_REF_A = "secret:///tenants/a/credentials/firebase";

  beforeEach(async () => {
    // Seed via the bypass (superuser) client so the row exists regardless of
    // any tenant GUC — the App parent (APP_A, tenant A) is already seeded above.
    await bypass.appConnection.create({
      data: {
        id: APP_CONN_A,
        tenantId: TENANT_A,
        appId: APP_A,
        kind: "FIREBASE",
        secretRef: SECRET_REF_A,
        metadata: { projectId: "proj-a", androidAppId: "1:1:android:abc", testerGroups: ["qa"] },
        createdById: USER_ID,
      },
    });
  });

  test("apply_tenant_isolation FORCEs RLS on the AppConnection table (rls.sql guard)", async () => {
    // Confirms `apply_tenant_isolation('AppConnection')` in prisma/rls.sql took
    // effect. If RLS were not (force-)enabled, gp_app — which holds a SELECT
    // grant — would see every tenant's rows and the assertions below would be
    // vacuously satisfied. This makes that precondition explicit.
    const rows = await bypass.$queryRawUnsafe<
      Array<{ relrowsecurity: boolean; relforcerowsecurity: boolean }>
    >(`SELECT relrowsecurity, relforcerowsecurity FROM pg_class WHERE relname = 'AppConnection'`);
    expect(rows[0]?.relrowsecurity).toBe(true);
    expect(rows[0]?.relforcerowsecurity).toBe(true);
  });

  test("the owning tenant CAN read its own AppConnection (proves the GUC reaches the query)", async () => {
    const own = await asTenant(TENANT_A, () => prisma.appConnection.findFirst({ where: { id: APP_CONN_A } }));
    expect(own?.id).toBe(APP_CONN_A);
    expect(own?.secretRef).toBe(SECRET_REF_A);
  });

  test("a tenant cannot READ another tenant's AppConnection by direct id", async () => {
    const stolen = await asTenant(TENANT_B, () => prisma.appConnection.findFirst({ where: { id: APP_CONN_A } }));
    expect(stolen).toBeNull();
  });

  test("a tenant cannot UPDATE another tenant's AppConnection secretRef", async () => {
    const res = await asTenant(TENANT_B, () =>
      prisma.appConnection.updateMany({ where: { id: APP_CONN_A }, data: { secretRef: "secret:///tenants/b/HIJACK" } }),
    );
    expect(res.count).toBe(0);
    const fresh = await bypass.appConnection.findUnique({ where: { id: APP_CONN_A } });
    expect(fresh?.secretRef).toBe(SECRET_REF_A);
  });

  test("a cross-tenant DELETE of an AppConnection affects zero rows", async () => {
    const res = await asTenant(TENANT_B, () => prisma.appConnection.deleteMany({ where: { id: APP_CONN_A } }));
    expect(res.count).toBe(0);
    expect(await bypass.appConnection.findUnique({ where: { id: APP_CONN_A } })).not.toBeNull();
  });
});

describe("RLS (production prisma client) — broader data model", () => {
  test("App is tenant-scoped", async () => {
    const list = await asTenant(TENANT_A, () => prisma.app.findMany());
    expect(list.map((a) => a.id)).toEqual([APP_A]);
  });

  test("cross-tenant DELETE has zero effect", async () => {
    const res = await asTenant(TENANT_A, () => prisma.app.deleteMany({ where: { id: APP_B } }));
    expect(res.count).toBe(0);
    expect(await bypass.app.findUnique({ where: { id: APP_B } })).not.toBeNull();
  });

  test("child rows (Screenshot) respect their parent's tenant", async () => {
    await bypass.appLocalization.create({ data: { tenantId: TENANT_A, appId: APP_A, locale: "en-US", name: "T" } });
    await bypass.screenshot.create({
      data: { tenantId: TENANT_A, appId: APP_A, locale: "en-US", fileName: "k.png", width: 1080, height: 1920, ordinal: 0, state: "COMPLETE", storageKey: "k" },
    });
    expect(await asTenant(TENANT_B, () => prisma.screenshot.findMany())).toHaveLength(0);
    expect(await asTenant(TENANT_A, () => prisma.screenshot.findMany())).toHaveLength(1);
  });

  test("an app-level $transaction([...]) batch stays tenant-scoped (worker push pattern)", async () => {
    // Worker processors call prisma.$transaction([update, upsert, ...]); make
    // sure the per-op tenant-context wrapper composes with an outer batch tx.
    await asTenant(TENANT_A, async () => {
      await prisma.$transaction([
        prisma.app.update({ where: { id: APP_A }, data: { appName: "A-renamed" } }),
      ]);
    });
    expect((await bypass.app.findUnique({ where: { id: APP_A } }))?.appName).toBe("A-renamed");
    // And the same batch cannot reach across tenants.
    await asTenant(TENANT_A, async () => {
      const r = await prisma.app.updateMany({ where: { id: APP_B }, data: { appName: "HACKED" } });
      expect(r.count).toBe(0);
    });
    expect((await bypass.app.findUnique({ where: { id: APP_B } }))?.appName).toBe("App B");
  });

  test("AuditEvent and Job are tenant-scoped", async () => {
    await bypass.auditEvent.createMany({
      data: [
        { tenantId: TENANT_A, userId: USER_ID, action: "test.a", target: APP_A, outcome: "SUCCESS" },
        { tenantId: TENANT_B, userId: USER_ID, action: "test.b", target: APP_B, outcome: "SUCCESS" },
      ],
    });
    await bypass.job.createMany({
      data: [
        { tenantId: TENANT_A, userId: USER_ID, kind: "metadata.push", status: "QUEUED", payload: {} },
        { tenantId: TENANT_B, userId: USER_ID, kind: "metadata.push", status: "QUEUED", payload: {} },
      ],
    });
    const events = await asTenant(TENANT_A, () => prisma.auditEvent.findMany());
    expect(events.map((e) => e.action)).toEqual(["test.a"]);
    const jobs = await asTenant(TENANT_B, () => prisma.job.findMany());
    expect(jobs.every((j) => j.tenantId === TENANT_B)).toBe(true);
  });
});

describe("RLS — bypass role", () => {
  test("the BYPASSRLS/admin connection sees all tenants (cross-tenant maintenance path)", async () => {
    const all = await bypass.credential.findMany();
    expect(all.map((c) => c.id).sort()).toEqual([CRED_A, CRED_B].sort());
  });

  test("the scoped client with bypassRls=true (no GUC) still gets zero rows as gp_app", async () => {
    // Defence-in-depth nuance: the bypassRls flag only SKIPS setting the GUC;
    // it does not grant the gp_app role bypass power. True cross-tenant access
    // must go through the BYPASSRLS admin role (prismaUnscoped/DATABASE_URL_ADMIN).
    const rows = await tenantStorage.run(
      { tenantId: TENANT_A, userId: USER_ID, role: "OWNER", requestId: "b", bypassRls: true },
      async () => await prisma.credential.findMany(),
    );
    expect(rows).toHaveLength(0);
  });
});
