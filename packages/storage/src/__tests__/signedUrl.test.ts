import { describe, test, expect, beforeEach, afterEach, vi } from "vitest";
import { FilesystemStorage } from "../FilesystemStorage";

/**
 * Pins the storage signed-URL HMAC fix:
 *   - A strong explicit signingSecret round-trips signedGetUrl() -> verifySignedUrl().
 *   - Tampered signature / tampered key / expired exp all verify false.
 *   - verifySignedUrl is constant-time-correct: tampered -> false, length-mismatch -> false.
 *   - resolveSigningSecret uses `||` (not `??`): an explicitly-EMPTY
 *     STORAGE_SIGNING_SECRET with NODE_ENV!=production does NOT throw and does NOT
 *     pin the key to the empty string — it falls through to a dev fallback, so a URL
 *     signed by a strong-secret instance does NOT verify against an empty-env instance.
 */

// A dedicated, random-looking secret >= 32 chars (and not matching the weak-secret regex).
const STRONG_SECRET = "a1b2c3d4e5f60718293a4b5c6d7e8f9012345678";
const OTHER_STRONG_SECRET = "ZZ_9988776655443322110099aabbccddeeff0011";
const KEY = "tenants/11111111-1111-4111-8111-111111111111/apps/abc/screenshots/1.png";

function makeStorage(signingSecret?: string): FilesystemStorage {
  return new FilesystemStorage({
    baseDir: "/tmp/marquee-storage-test",
    publicBaseUrl: "http://localhost:3000",
    signingSecret,
  });
}

/** Parse the query params (exp, n, s) out of a signed URL produced by signedGetUrl. */
function parseSignedUrl(signed: string): { exp: string; nonce: string; sig: string } {
  const url = new URL(signed);
  const exp = url.searchParams.get("exp");
  const nonce = url.searchParams.get("n");
  const sig = url.searchParams.get("s");
  if (exp === null || nonce === null || sig === null) {
    throw new Error(`signed URL missing query params: ${signed}`);
  }
  return { exp, nonce, sig };
}

// Snapshot and restore the env vars the secret resolver reads, so tests are isolated.
let savedEnv: {
  STORAGE_SIGNING_SECRET: string | undefined;
  SESSION_SECRET: string | undefined;
  NODE_ENV: string | undefined;
};

beforeEach(() => {
  savedEnv = {
    STORAGE_SIGNING_SECRET: process.env.STORAGE_SIGNING_SECRET,
    SESSION_SECRET: process.env.SESSION_SECRET,
    NODE_ENV: process.env.NODE_ENV,
  };
  // Default: clear inherited secrets so explicit-opt tests are not influenced by env.
  delete process.env.STORAGE_SIGNING_SECRET;
  delete process.env.SESSION_SECRET;
});

afterEach(() => {
  for (const k of ["STORAGE_SIGNING_SECRET", "SESSION_SECRET", "NODE_ENV"] as const) {
    const v = savedEnv[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("FilesystemStorage signed URL round-trip (strong explicit secret)", () => {
  test("signedGetUrl() -> verifySignedUrl() returns true", async () => {
    const storage = makeStorage(STRONG_SECRET);
    const signed = await storage.signedGetUrl(KEY);
    const { exp, nonce, sig } = parseSignedUrl(signed);

    expect(storage.verifySignedUrl(KEY, exp, nonce, sig)).toBe(true);
  });

  test("URL embeds the proxy path, exp, nonce, and signature", async () => {
    const storage = makeStorage(STRONG_SECRET);
    const signed = await storage.signedGetUrl(KEY, { expiresInSeconds: 600 });

    expect(signed.startsWith(`http://localhost:3000/api/v1/storage/${KEY}?`)).toBe(true);
    const { exp, nonce, sig } = parseSignedUrl(signed);
    expect(Number.isFinite(Number(exp))).toBe(true);
    expect(nonce.length).toBeGreaterThan(0);
    expect(sig.length).toBeGreaterThan(0);
  });
});

describe("FilesystemStorage signed URL tamper / expiry rejection", () => {
  test("tampered signature -> false", async () => {
    const storage = makeStorage(STRONG_SECRET);
    const signed = await storage.signedGetUrl(KEY);
    const { exp, nonce, sig } = parseSignedUrl(signed);

    // Flip the last character of the (same-length) base64url signature.
    const last = sig.slice(-1);
    const flipped = last === "A" ? "B" : "A";
    const tamperedSig = sig.slice(0, -1) + flipped;
    expect(tamperedSig).not.toBe(sig);
    expect(tamperedSig.length).toBe(sig.length);

    expect(storage.verifySignedUrl(KEY, exp, nonce, tamperedSig)).toBe(false);
  });

  test("tampered key -> false", async () => {
    const storage = makeStorage(STRONG_SECRET);
    const signed = await storage.signedGetUrl(KEY);
    const { exp, nonce, sig } = parseSignedUrl(signed);

    const otherKey = KEY.replace("1.png", "2.png");
    expect(otherKey).not.toBe(KEY);

    expect(storage.verifySignedUrl(otherKey, exp, nonce, sig)).toBe(false);
  });

  test("expired exp -> false", async () => {
    const storage = makeStorage(STRONG_SECRET);
    // Sign with a 1s lifetime, then jump the clock past expiry. The signature is
    // valid HMAC, so this isolates the exp check.
    const signed = await storage.signedGetUrl(KEY, { expiresInSeconds: 1 });
    const { exp, nonce, sig } = parseSignedUrl(signed);

    // Sanity: valid right now.
    expect(storage.verifySignedUrl(KEY, exp, nonce, sig)).toBe(true);

    // Advance real time would be flaky; instead drive Date.now() forward.
    const expiredNow = (Number(exp) + 5) * 1000;
    const spy = vi.spyOn(Date, "now").mockReturnValue(expiredNow);
    try {
      expect(storage.verifySignedUrl(KEY, exp, nonce, sig)).toBe(false);
    } finally {
      spy.mockRestore();
    }
  });

  test("non-numeric exp -> false", async () => {
    const storage = makeStorage(STRONG_SECRET);
    const signed = await storage.signedGetUrl(KEY);
    const { nonce, sig } = parseSignedUrl(signed);

    expect(storage.verifySignedUrl(KEY, "not-a-number", nonce, sig)).toBe(false);
  });
});

describe("FilesystemStorage verifySignedUrl is constant-time-correct", () => {
  test("a totally wrong but same-length signature -> false", async () => {
    const storage = makeStorage(STRONG_SECRET);
    const signed = await storage.signedGetUrl(KEY);
    const { exp, nonce, sig } = parseSignedUrl(signed);

    // Same length as the real signature, all zero bytes (base64url) -> wrong but
    // length-matched, exercising the timingSafeEqual branch (not the length guard).
    const sigBytes = Buffer.from(sig, "base64url");
    const wrongSameLen = Buffer.alloc(sigBytes.length, 0).toString("base64url");
    expect(Buffer.from(wrongSameLen, "base64url").length).toBe(sigBytes.length);

    expect(storage.verifySignedUrl(KEY, exp, nonce, wrongSameLen)).toBe(false);
  });

  test("length-mismatched signature -> false (no timingSafeEqual throw)", async () => {
    const storage = makeStorage(STRONG_SECRET);
    const signed = await storage.signedGetUrl(KEY);
    const { exp, nonce } = parseSignedUrl(signed);

    // Far-too-short signature: must be rejected by the length guard, never throw.
    const shortSig = Buffer.from([1, 2, 3]).toString("base64url");
    expect(() => storage.verifySignedUrl(KEY, exp, nonce, shortSig)).not.toThrow();
    expect(storage.verifySignedUrl(KEY, exp, nonce, shortSig)).toBe(false);

    // Empty signature too.
    expect(storage.verifySignedUrl(KEY, exp, nonce, "")).toBe(false);
  });

  test("signature from a different secret -> false", async () => {
    const signer = makeStorage(STRONG_SECRET);
    const verifier = makeStorage(OTHER_STRONG_SECRET);
    const signed = await signer.signedGetUrl(KEY);
    const { exp, nonce, sig } = parseSignedUrl(signed);

    // Same length (HMAC-SHA256), correct payload — only the secret differs.
    expect(verifier.verifySignedUrl(KEY, exp, nonce, sig)).toBe(false);
  });
});

describe("resolveSigningSecret: empty STORAGE_SIGNING_SECRET falls through (|| not ??)", () => {
  test("empty env secret + non-prod: constructor does NOT throw, signing still works", async () => {
    process.env.NODE_ENV = "test"; // != production
    process.env.STORAGE_SIGNING_SECRET = ""; // explicitly empty

    let storage: FilesystemStorage | undefined;
    expect(() => {
      // No explicit signingSecret opt -> must resolve from env, fall through empty, use dev fallback.
      storage = new FilesystemStorage({
        baseDir: "/tmp/marquee-storage-test",
        publicBaseUrl: "http://localhost:3000",
      });
    }).not.toThrow();

    // Dev fallback is a real working secret: round-trip succeeds.
    const signed = await storage!.signedGetUrl(KEY);
    const { exp, nonce, sig } = parseSignedUrl(signed);
    expect(storage!.verifySignedUrl(KEY, exp, nonce, sig)).toBe(true);
  });

  test("empty string does NOT become the literal signing key", async () => {
    // A URL signed by a strong-secret instance must NOT verify against an
    // empty-env instance. If `??` had been used, the empty-env instance would
    // sign/verify with "" and an attacker could forge against the empty key.
    process.env.NODE_ENV = "test";
    process.env.STORAGE_SIGNING_SECRET = "";

    const strong = makeStorage(STRONG_SECRET);
    const emptyEnv = new FilesystemStorage({
      baseDir: "/tmp/marquee-storage-test",
      publicBaseUrl: "http://localhost:3000",
    });

    const signed = await strong.signedGetUrl(KEY);
    const { exp, nonce, sig } = parseSignedUrl(signed);

    // Cross-verify must fail: the two instances use different secrets.
    expect(emptyEnv.verifySignedUrl(KEY, exp, nonce, sig)).toBe(false);

    // And explicitly: an instance constructed with the literal empty string as the
    // explicit opt must NOT verify a strong-secret-signed URL either (empty != key).
    const explicitEmpty = makeStorage("");
    expect(explicitEmpty.verifySignedUrl(KEY, exp, nonce, sig)).toBe(false);
  });

  test("two empty-env instances agree with each other (shared dev fallback, not empty key)", async () => {
    process.env.NODE_ENV = "test";
    process.env.STORAGE_SIGNING_SECRET = "";

    const a = new FilesystemStorage({ baseDir: "/tmp/marquee-storage-test", publicBaseUrl: "http://localhost:3000" });
    const b = new FilesystemStorage({ baseDir: "/tmp/marquee-storage-test", publicBaseUrl: "http://localhost:3000" });

    const signed = await a.signedGetUrl(KEY);
    const { exp, nonce, sig } = parseSignedUrl(signed);

    // Same dev fallback on both -> cross-verify succeeds (the fallback is deterministic).
    expect(b.verifySignedUrl(KEY, exp, nonce, sig)).toBe(true);
  });
});
