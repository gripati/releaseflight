/**
 * Content-Security-Policy builder tests — pins the production hardening fix:
 * production drops `'unsafe-inline'`/`'unsafe-eval'` from `script-src` in favour
 * of a per-request nonce + `'strict-dynamic'`, upgrades insecure requests, and
 * locks framing/objects down. Development deliberately relaxes those for HMR.
 *
 * Pure string assembly under test, but we stub+restore the optional
 * CSP_EXTRA_* env vars so the assertions stay deterministic regardless of the
 * runner's environment.
 */
import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { buildCsp } from "../csp";

// Env vars buildCsp consults for host-injected extras. We snapshot and restore
// them manually (rather than vi.stubEnv) so the suite stays deterministic
// without depending on vitest's env-unstub config.
const EXTRA_ENV_KEYS = [
  "CSP_EXTRA_CONNECT",
  "CSP_EXTRA_IMG",
  "CSP_EXTRA_SCRIPT",
] as const;

// A nonce with regex-special chars would be a problem for naive matchers — we
// use a plain base64url-ish token, the same shape middleware emits.
const NONCE = "abc123NONCExyz789==";

/** Pull a single directive (e.g. "script-src") out of the assembled policy. */
function directive(policy: string, name: string): string | undefined {
  return policy
    .split(";")
    .map((d) => d.trim())
    .find((d) => d === name || d.startsWith(`${name} `));
}

describe("buildCsp", () => {
  const saved: Record<string, string | undefined> = {};

  beforeEach(() => {
    // Snapshot then neutralise host-injected extras so the policy is fully
    // deterministic regardless of the runner's environment.
    for (const key of EXTRA_ENV_KEYS) {
      saved[key] = process.env[key];
      process.env[key] = "";
    }
  });

  afterEach(() => {
    for (const key of EXTRA_ENV_KEYS) {
      if (saved[key] === undefined) delete process.env[key];
      else process.env[key] = saved[key];
    }
  });

  describe("production (isProd: true)", () => {
    let policy: string;
    let scriptSrc: string;

    beforeEach(() => {
      policy = buildCsp({ nonce: NONCE, isProd: true });
      scriptSrc = directive(policy, "script-src") ?? "";
    });

    test("script-src carries the verbatim nonce", () => {
      expect(scriptSrc).toContain(`'nonce-${NONCE}'`);
      // the nonce string itself must appear verbatim, not escaped/mangled
      expect(policy).toContain(NONCE);
    });

    test("script-src uses strict-dynamic", () => {
      expect(scriptSrc).toContain("'strict-dynamic'");
    });

    test("script-src has no unsafe-inline or unsafe-eval", () => {
      expect(scriptSrc).not.toContain("'unsafe-inline'");
      expect(scriptSrc).not.toContain("'unsafe-eval'");
    });

    test("upgrade-insecure-requests is present", () => {
      expect(directive(policy, "upgrade-insecure-requests")).toBe(
        "upgrade-insecure-requests",
      );
    });

    test("object-src is 'none'", () => {
      expect(directive(policy, "object-src")).toBe("object-src 'none'");
    });

    test("frame-ancestors is 'none'", () => {
      expect(directive(policy, "frame-ancestors")).toBe(
        "frame-ancestors 'none'",
      );
    });

    test("connect-src does not allow plaintext websockets", () => {
      const connectSrc = directive(policy, "connect-src") ?? "";
      expect(connectSrc).toBe("connect-src 'self'");
      expect(connectSrc).not.toMatch(/\bws:/);
      expect(connectSrc).not.toContain("wss:");
    });
  });

  describe("development (isProd: false)", () => {
    let policy: string;
    let scriptSrc: string;

    beforeEach(() => {
      policy = buildCsp({ nonce: NONCE, isProd: false });
      scriptSrc = directive(policy, "script-src") ?? "";
    });

    test("script-src allows unsafe-eval and unsafe-inline for HMR", () => {
      expect(scriptSrc).toContain("'unsafe-eval'");
      expect(scriptSrc).toContain("'unsafe-inline'");
    });

    test("script-src still carries the verbatim nonce", () => {
      expect(scriptSrc).toContain(`'nonce-${NONCE}'`);
    });

    test("script-src does not use strict-dynamic in dev", () => {
      expect(scriptSrc).not.toContain("'strict-dynamic'");
    });

    test("connect-src allows ws: and wss: for the dev socket", () => {
      const connectSrc = directive(policy, "connect-src") ?? "";
      expect(connectSrc).toContain("ws:");
      expect(connectSrc).toContain("wss:");
    });

    test("does not upgrade insecure requests in dev", () => {
      expect(directive(policy, "upgrade-insecure-requests")).toBeUndefined();
      expect(policy).not.toContain("upgrade-insecure-requests");
    });
  });

  describe("store CDN hosts (both environments)", () => {
    // A representative Apple host and a representative Google host that must be
    // reachable for App Store / Play pre-signed image & video URLs.
    const APPLE_HOST = "https://*.mzstatic.com";
    const GOOGLE_HOST = "https://play-lh.googleusercontent.com";

    for (const isProd of [true, false]) {
      test(`img-src includes Apple + Google store CDN hosts (isProd=${isProd})`, () => {
        const policy = buildCsp({ nonce: NONCE, isProd });
        const imgSrc = directive(policy, "img-src") ?? "";
        expect(imgSrc).toContain(APPLE_HOST);
        expect(imgSrc).toContain(GOOGLE_HOST);
      });

      test(`media-src includes Apple + Google store CDN hosts (isProd=${isProd})`, () => {
        const policy = buildCsp({ nonce: NONCE, isProd });
        const mediaSrc = directive(policy, "media-src") ?? "";
        expect(mediaSrc).toContain(APPLE_HOST);
        expect(mediaSrc).toContain(GOOGLE_HOST);
      });
    }
  });

  describe("upgrade-insecure-requests gated on secure scheme", () => {
    // Regression: a self-host box served over plain http://localhost must NOT
    // emit upgrade-insecure-requests, or the browser rewrites every http
    // subresource (/_next/*.css|js) to https with no TLS listener → unstyled,
    // non-interactive page.
    test("prod + secure=false (plain http) omits upgrade-insecure-requests", () => {
      const policy = buildCsp({ nonce: NONCE, isProd: true, secure: false });
      expect(policy).not.toContain("upgrade-insecure-requests");
    });

    test("prod + secure=true (https) emits upgrade-insecure-requests", () => {
      const policy = buildCsp({ nonce: NONCE, isProd: true, secure: true });
      expect(directive(policy, "upgrade-insecure-requests")).toBe(
        "upgrade-insecure-requests",
      );
    });

    test("prod defaults to secure (upgrade present when secure omitted)", () => {
      const policy = buildCsp({ nonce: NONCE, isProd: true });
      expect(policy).toContain("upgrade-insecure-requests");
    });

    test("dev never upgrades even when secure=true", () => {
      const policy = buildCsp({ nonce: NONCE, isProd: false, secure: true });
      expect(policy).not.toContain("upgrade-insecure-requests");
    });
  });
});
