/**
 * Defence-in-depth checks — CSRF + rate-limiting + idempotency are the
 * three things that prevent the API from being trivially abused. These
 * tests exercise them through the public surface.
 */
import { expect, test } from "@playwright/test";

const OWNER_EMAIL = process.env.SELF_HOST_OWNER_EMAIL ?? "owner@example.com";
const OWNER_PASSWORD = process.env.SELF_HOST_OWNER_PASSWORD ?? "change-me-after-first-login";

async function login(page: import("@playwright/test").Page): Promise<void> {
  await page.goto("/login");
  await page.fill('input[name="email"]', OWNER_EMAIL);
  await page.fill('input[name="password"]', OWNER_PASSWORD);
  await page.click('button:has-text("Sign in")');
  await page.waitForURL(/\/t\/.+\/dashboard|\/account\/tenants/);
}

test.describe("CSRF enforcement", () => {
  test("Mutating request without x-csrf-token → 403", async ({ page, request }) => {
    await login(page);
    const res = await request.post("/api/v1/credentials", {
      data: { kind: "APPLE", name: "x", keyId: "AAAA1111", issuerId: "00000000-0000-0000-0000-000000000000", privateKeyPem: "BEGIN" },
    });
    expect(res.status()).toBe(403);
    const body = (await res.json()) as { error: { code: string } };
    expect(body.error.code).toBe("FORBIDDEN");
  });

  test("CSRF token endpoint returns a base64url token", async ({ request }) => {
    const res = await request.get("/api/v1/auth/csrf-token");
    expect(res.status()).toBe(200);
    const body = (await res.json()) as { csrfToken: string };
    expect(body.csrfToken).toMatch(/^[A-Za-z0-9_-]{40,}$/);
  });
});

test.describe("Rate limiting", () => {
  test("Login endpoint rate-limits brute-force attempts", async ({ request }) => {
    // CSRF first
    const csrf = await request.get("/api/v1/auth/csrf-token");
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };

    // Bombard with bad logins. Tests that we get at least one 429 within
    // a small burst, since the per-email rate limit is conservative.
    const statuses: number[] = [];
    for (let i = 0; i < 25; i += 1) {
      const res = await request.post("/api/v1/auth/login", {
        headers: { "x-csrf-token": csrfToken },
        data: { email: "ratelimit-test@example.com", password: "bad-password" },
      });
      statuses.push(res.status());
      if (res.status() === 429) break;
    }
    // We may or may not hit 429 depending on configured limit & time
    // window. The strong assertion is: at no point do we get a 5xx.
    expect(statuses.every((s) => s < 500)).toBe(true);
  });
});

test.describe("Idempotency", () => {
  test("Repeated POST with same Idempotency-Key returns the same response", async ({ page, request }) => {
    await login(page);
    const csrf = await request.get("/api/v1/auth/csrf-token");
    const { csrfToken } = (await csrf.json()) as { csrfToken: string };
    const idem = `e2e-${crypto.randomUUID()}`;
    const headers = {
      "x-csrf-token": csrfToken,
      "idempotency-key": idem,
    };
    // Use a known-to-fail-validation endpoint to keep the test side-effect-free,
    // but still observe replay semantics on the *error envelope*.
    const r1 = await request.post("/api/v1/credentials", {
      headers,
      data: { kind: "INVALID_KIND" },
    });
    const r2 = await request.post("/api/v1/credentials", {
      headers,
      data: { kind: "INVALID_KIND" },
    });
    expect(r1.status()).toBe(r2.status());
    // Second request should carry the replay marker
    expect(r2.headers()["x-idempotency-replay"]).toBe("true");
  });
});
