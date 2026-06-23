/**
 * Envelope encryption for secrets at rest.
 *
 * Every credential the platform stores (Apple `.p8`, Google/Firebase
 * service-account JSON with RSA private keys, SSH deploy keys, Android
 * keystores AND their passwords) is AES-256-GCM encrypted before it touches
 * disk. The master key (KEK) comes from `SECRETS_ENCRYPTION_KEY`; the
 * tenant+credential identity is bound in as AEAD additional-authenticated-data
 * so a ciphertext blob cannot be relocated to another credential slot.
 *
 * Blob format (ASCII, single line):  `MQENC1:<iv_b64>.<tag_b64>.<ct_b64>`
 * The `MQENC1:` prefix unambiguously distinguishes an encrypted blob from a
 * legacy plaintext secret (which is real credential material — often JSON
 * starting with `{` — and so never carries this marker), enabling lazy,
 * read-compatible migration: old plaintext is read as-is and re-encrypted on
 * the next write.
 */
import { createCipheriv, createDecipheriv, randomBytes, createHash } from "node:crypto";

const MAGIC = "MQENC1";
const ALG = "aes-256-gcm";

/**
 * Resolve the 32-byte master key from `SECRETS_ENCRYPTION_KEY`. Accepts a
 * 64-char hex string, a 32-byte base64 value, or any passphrase (hashed to 32
 * bytes via SHA-256). Returns null when unset.
 */
export function loadMasterKey(): Buffer | null {
  const raw = process.env.SECRETS_ENCRYPTION_KEY?.trim();
  if (!raw) return null;
  if (/^[0-9a-f]{64}$/i.test(raw)) return Buffer.from(raw, "hex");
  const b64 = tryBase64(raw);
  if (b64?.length === 32) return b64;
  // Arbitrary passphrase — derive a stable 32-byte key.
  return createHash("sha256").update(raw, "utf8").digest();
}

function tryBase64(s: string): Buffer | null {
  try {
    return Buffer.from(s, "base64");
  } catch {
    return null;
  }
}

export function isEncrypted(content: string): boolean {
  return content.startsWith(`${MAGIC}:`);
}

export function encryptSecret(plaintext: string, key: Buffer, aad: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALG, key, iv);
  cipher.setAAD(Buffer.from(aad, "utf8"));
  const ct = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `${MAGIC}:${iv.toString("base64")}.${tag.toString("base64")}.${ct.toString("base64")}`;
}

export function decryptSecret(blob: string, key: Buffer, aad: string): string {
  const body = blob.slice(MAGIC.length + 1);
  const [ivB64, tagB64, ctB64] = body.split(".");
  if (ivB64 === undefined || tagB64 === undefined || ctB64 === undefined) {
    throw new Error("Malformed encrypted secret blob");
  }
  const iv = Buffer.from(ivB64, "base64");
  const tag = Buffer.from(tagB64, "base64");
  const ct = Buffer.from(ctB64, "base64");
  const decipher = createDecipheriv(ALG, key, iv);
  decipher.setAAD(Buffer.from(aad, "utf8"));
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ct), decipher.final()]).toString("utf8");
}
