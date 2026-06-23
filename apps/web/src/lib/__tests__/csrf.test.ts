/**
 * CSRF integration tests — covers the full double-submit cookie flow with
 * a stubbed `next/headers` cookie store.
 *
 * Why integration-style: we exercise the real `assertCsrf` /
 * `ensureCsrfToken` code paths including the Node `crypto` calls.
 */
import { beforeEach, describe, expect, test, vi } from "vitest";
import { ForbiddenError } from "@marquee/core";

const cookieStore = new Map<string, { value: string }>();

vi.mock("next/headers", () => ({
  cookies: async (): Promise<{
    get: (n: string) => { value: string } | undefined;
    set: (n: string, v: string, _opts?: unknown) => void;
  }> => ({
    get: (name: string) => cookieStore.get(name),
    set: (name: string, value: string) => {
      cookieStore.set(name, { value });
    },
  }),
}));

import {
  CSRF_COOKIE,
  CSRF_HEADER,
  assertCsrf,
  ensureCsrfToken,
  readCsrfCookie,
} from "../csrf";

beforeEach(() => {
  cookieStore.clear();
});

describe("CSRF — ensureCsrfToken", () => {
  test("issues a fresh base64url token of 43+ chars when absent", async () => {
    const token = await ensureCsrfToken();
    expect(token.length).toBeGreaterThanOrEqual(43);
    expect(token).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(cookieStore.get(CSRF_COOKIE)?.value).toBe(token);
  });

  test("returns the existing token on subsequent calls", async () => {
    const first = await ensureCsrfToken();
    const second = await ensureCsrfToken();
    expect(second).toBe(first);
  });

  test("rotates short / tampered cookies", async () => {
    cookieStore.set(CSRF_COOKIE, { value: "short" });
    const token = await ensureCsrfToken();
    expect(token).not.toBe("short");
    expect(token.length).toBeGreaterThanOrEqual(43);
  });
});

describe("CSRF — assertCsrf", () => {
  test("succeeds when header matches cookie", async () => {
    const token = await ensureCsrfToken();
    await expect(assertCsrf(token)).resolves.toBeUndefined();
  });

  test("rejects when header is missing", async () => {
    await ensureCsrfToken();
    await expect(assertCsrf(null)).rejects.toThrow(ForbiddenError);
  });

  test("rejects when cookie is missing", async () => {
    await expect(assertCsrf("aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa")).rejects.toThrow(ForbiddenError);
  });

  test("rejects mismatched header (timing-safe)", async () => {
    await ensureCsrfToken();
    await expect(assertCsrf("Z".repeat(43))).rejects.toThrow(ForbiddenError);
  });

  test("rejects when header length differs from cookie", async () => {
    const token = await ensureCsrfToken();
    await expect(assertCsrf(token.slice(0, -5))).rejects.toThrow(ForbiddenError);
  });

  test("readCsrfCookie returns null if never set", async () => {
    expect(await readCsrfCookie()).toBeNull();
  });
});

describe("CSRF — header / cookie names are stable", () => {
  test("public constants do not drift", () => {
    expect(CSRF_COOKIE).toBe("gp_csrf");
    expect(CSRF_HEADER).toBe("x-csrf-token");
  });
});
