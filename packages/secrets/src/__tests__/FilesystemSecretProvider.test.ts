import { afterEach, beforeEach, describe, expect, test } from "vitest";
import { mkdtempSync, rmSync, statSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { FilesystemSecretProvider } from "../FilesystemSecretProvider";

const TENANT = "11111111-1111-4111-8111-111111111111";
const CRED = "22222222-2222-4222-8222-222222222222";
const OTHER_CRED = "33333333-3333-4333-8333-333333333333";

let dir: string;
let sp: FilesystemSecretProvider;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "gp-secrets-"));
  sp = new FilesystemSecretProvider(dir);
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe("FilesystemSecretProvider", () => {
  test("put → get round-trip preserves content + metadata", async () => {
    const ref = await sp.put(TENANT, CRED, {
      kind: "APPLE",
      content: "-----BEGIN PRIVATE KEY-----\nABC\n-----END PRIVATE KEY-----",
      metadata: { keyId: "ABC123", issuerId: "uuid" },
    });
    expect(ref).toBe(`filesystem:///tenants/${TENANT}/credentials/${CRED}`);

    const material = await sp.get(ref);
    expect(material.kind).toBe("APPLE");
    expect(material.content).toContain("BEGIN PRIVATE KEY");
    expect(material.metadata?.keyId).toBe("ABC123");
  });

  test("file permissions are 0600 (owner read/write only)", async () => {
    const ref = await sp.put(TENANT, CRED, { kind: "APPLE", content: "x" });
    const contentPath = join(dir, "tenants", TENANT, "credentials", `${CRED}.content`);
    const mode = statSync(contentPath).mode & 0o777;
    // On macOS umask can lower the mode; the important thing is no group/other access
    expect(mode & 0o077).toBe(0);
    void ref;
  });

  test("listForTenant returns refs for the right tenant only", async () => {
    await sp.put(TENANT, CRED, { kind: "APPLE", content: "a" });
    await sp.put(TENANT, OTHER_CRED, { kind: "GOOGLE", content: "b" });
    await sp.put("99999999-9999-4999-8999-999999999999", CRED, { kind: "APPLE", content: "c" });

    const refs = await sp.listForTenant(TENANT);
    expect(refs.length).toBe(2);
    expect(refs.every((r) => r.includes(TENANT))).toBe(true);
  });

  test("delete removes both content + meta files", async () => {
    const ref = await sp.put(TENANT, CRED, { kind: "APPLE", content: "x" });
    await sp.delete(ref);
    const refs = await sp.listForTenant(TENANT);
    expect(refs).toEqual([]);
  });

  test("delete on missing ref is a no-op (no throw)", async () => {
    const ref = `filesystem:///tenants/${TENANT}/credentials/${CRED}`;
    await expect(sp.delete(ref)).resolves.toBeUndefined();
  });

  test("invalid ref → ValidationError", async () => {
    await expect(sp.get("aws-sm:///foo")).rejects.toThrow();
    await expect(sp.get("filesystem:///wrong/format")).rejects.toThrow();
  });

  test("invalid tenant/credential id → ValidationError", async () => {
    await expect(sp.put("not-a-uuid", CRED, { kind: "APPLE", content: "x" })).rejects.toThrow();
  });

  test("healthCheck reports OK when baseDir is writable", async () => {
    const res = await sp.healthCheck?.();
    expect(res?.ok).toBe(true);
  });
});

describe("FilesystemSecretProvider — encryption at rest (SECRETS_ENCRYPTION_KEY)", () => {
  const KEY = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"; // 64 hex
  let encDir: string;

  beforeEach(() => {
    process.env.SECRETS_ENCRYPTION_KEY = KEY;
    encDir = mkdtempSync(join(tmpdir(), "gp-secrets-enc-"));
  });
  afterEach(() => {
    delete process.env.SECRETS_ENCRYPTION_KEY;
    rmSync(encDir, { recursive: true, force: true });
  });

  test("content + metadata are encrypted on disk but round-trip cleanly", async () => {
    const enc = new FilesystemSecretProvider(encDir);
    const plaintext = "-----BEGIN PRIVATE KEY-----\nSUPERSECRET\n-----END PRIVATE KEY-----";
    const ref = await enc.put(TENANT, CRED, {
      kind: "ANDROID_KEYSTORE",
      content: plaintext,
      metadata: { storePassword: "hunter2", keyAlias: "upload" },
    });

    // On-disk content must NOT contain the plaintext or the keystore password.
    const contentPath = join(encDir, "tenants", TENANT, "credentials", `${CRED}.content`);
    const metaPath = join(encDir, "tenants", TENANT, "credentials", `${CRED}.meta.json`);
    const rawContent = readFileSync(contentPath, "utf8");
    const rawMeta = readFileSync(metaPath, "utf8");
    expect(rawContent.startsWith("MQENC1:")).toBe(true);
    expect(rawContent).not.toContain("SUPERSECRET");
    expect(rawMeta).not.toContain("hunter2");
    expect(rawMeta).toContain("encMetadata");

    // Round-trip returns the original material.
    const material = await enc.get(ref);
    expect(material.content).toBe(plaintext);
    expect(material.metadata?.storePassword).toBe("hunter2");
    expect(material.metadata?.keyAlias).toBe("upload");
  });

  test("legacy plaintext written without a key is still readable after a key is set (lazy migration)", async () => {
    // Write WITHOUT a key (plaintext on disk).
    delete process.env.SECRETS_ENCRYPTION_KEY;
    const plainProvider = new FilesystemSecretProvider(encDir);
    const ref = await plainProvider.put(TENANT, CRED, { kind: "APPLE", content: "legacy-cleartext" });

    // Now a key is configured; reading the legacy blob must still work.
    process.env.SECRETS_ENCRYPTION_KEY = KEY;
    const keyed = new FilesystemSecretProvider(encDir);
    const material = await keyed.get(ref);
    expect(material.content).toBe("legacy-cleartext");
  });
});
