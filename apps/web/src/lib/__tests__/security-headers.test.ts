/**
 * Plain-HTTP self-host hardening: TLS-only browser protections must key off the
 * deployment scheme (APP_URL), NOT `NODE_ENV` alone. A self-host box on
 * http://localhost:3000 runs with NODE_ENV=production but no TLS — so `Secure`
 * cookies and HSTS would break it if gated on NODE_ENV. These tests pin the
 * agreed predicate (see docs/11_SELF_HOST_TO_SAAS.md §11.1.4):
 *   HTTPS deployment ⇔ NODE_ENV==="production" && !APP_URL.startsWith("http://")
 *
 * `useSecureCookies()` (cookies) and `next.config.mjs` (HSTS) must both follow
 * it, so a real https deploy keeps every protection while an http box drops the
 * ones browsers can't honour over plaintext.
 */
import { afterEach, describe, expect, test } from "vitest";
import { useSecureCookies } from "../cookie-security";
// next.config.mjs lives outside src/ but reads env at headers()-call time, so we
// can import it and exercise the HSTS gate directly.
import nextConfig from "../../../next.config.mjs";

const SAVED = {
  NODE_ENV: process.env.NODE_ENV,
  APP_URL: process.env.APP_URL,
};

function setEnv(nodeEnv: string | undefined, appUrl: string | undefined): void {
  // process.env.NODE_ENV is typed read-only; cast to a plain record to override
  // it per-test (we restore the originals in afterEach).
  const env = process.env as Record<string, string | undefined>;
  if (nodeEnv === undefined) delete env.NODE_ENV;
  else env.NODE_ENV = nodeEnv;
  if (appUrl === undefined) delete env.APP_URL;
  else env.APP_URL = appUrl;
}

afterEach(() => {
  setEnv(SAVED.NODE_ENV, SAVED.APP_URL);
});

describe("useSecureCookies — scheme-gated Secure flag", () => {
  test("prod + https APP_URL ⇒ Secure", () => {
    setEnv("production", "https://app.releaseflight.com");
    expect(useSecureCookies()).toBe(true);
  });

  test("prod + plain-http APP_URL ⇒ NOT Secure (browsers would drop the cookie)", () => {
    setEnv("production", "http://localhost:3000");
    expect(useSecureCookies()).toBe(false);
  });

  test("prod + missing APP_URL ⇒ Secure (fail-safe, never downgrade a real TLS deploy)", () => {
    setEnv("production", undefined);
    expect(useSecureCookies()).toBe(true);
  });

  test("non-production ⇒ never Secure (local dev over http)", () => {
    setEnv("development", "https://app.releaseflight.com");
    expect(useSecureCookies()).toBe(false);
  });
});

describe("next.config HSTS — gated on deployment scheme, not NODE_ENV", () => {
  /** Pull the Strict-Transport-Security value out of the global header block. */
  async function hsts(): Promise<string | undefined> {
    const groups = (await nextConfig.headers?.()) ?? [];
    const global = groups.find((g) => g.source === "/(.*)");
    return global?.headers.find((h) => h.key === "Strict-Transport-Security")
      ?.value;
  }

  test("prod + https APP_URL emits HSTS", async () => {
    setEnv("production", "https://app.releaseflight.com");
    expect(await hsts()).toMatch(/max-age=\d+/);
  });

  test("prod + plain-http APP_URL omits HSTS (would brick a non-localhost http box)", async () => {
    setEnv("production", "http://localhost:3000");
    expect(await hsts()).toBeUndefined();
  });

  test("prod + missing APP_URL emits HSTS (fail-safe)", async () => {
    setEnv("production", undefined);
    expect(await hsts()).toMatch(/max-age=\d+/);
  });

  test("non-production never emits HSTS", async () => {
    setEnv("development", "https://app.releaseflight.com");
    expect(await hsts()).toBeUndefined();
  });

  test("HSTS gate agrees with useSecureCookies for every scheme/env combo", async () => {
    for (const nodeEnv of ["production", "development", "test"]) {
      for (const appUrl of [
        "https://app.releaseflight.com",
        "http://localhost:3000",
        undefined,
      ]) {
        setEnv(nodeEnv, appUrl);
        const hstsOn = (await hsts()) !== undefined;
        expect(hstsOn).toBe(useSecureCookies());
      }
    }
  });
});
