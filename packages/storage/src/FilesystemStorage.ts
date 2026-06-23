import fs from "node:fs/promises";
import { createReadStream, createWriteStream } from "node:fs";
import type { Dirent } from "node:fs";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { Readable } from "node:stream";
import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";
import { ValidationError } from "@marquee/core";

const WEAK_SECRET_RE = /change-?me|fallback|insecure|placeholder/i;

/**
 * Resolve the HMAC signing secret used for storage proxy URLs.
 *
 * Uses `||` (not `??`) so an explicitly-empty `STORAGE_SIGNING_SECRET=` falls
 * through instead of pinning the key to the empty string (the prior `??` chain
 * shipped an empty/predictable key under the default config — unauthenticated
 * signed-URL forgery). There is no hard-coded production default: a missing,
 * short (<32 char), or placeholder secret throws at construction in production.
 * Outside production a clearly-labelled dev key keeps local signed URLs working.
 */
function resolveSigningSecret(explicit?: string): string {
  const candidate =
    explicit?.trim() ||
    process.env.STORAGE_SIGNING_SECRET?.trim() ||
    process.env.SESSION_SECRET?.trim() ||
    "";
  const isProd = process.env.NODE_ENV === "production";
  // Runtime requirement only — skip during Next's production build phase.
  const isNextBuild = process.env.NEXT_PHASE === "phase-production-build";
  const weak = candidate.length < 32 || WEAK_SECRET_RE.test(candidate);
  if (weak) {
    if (isProd && !isNextBuild) {
      throw new Error(
        "STORAGE_SIGNING_SECRET is missing or weak: configure a dedicated random secret " +
          "of at least 32 characters. Refusing to start with a predictable storage-URL signing key.",
      );
    }
    return "dev-only-insecure-storage-signing-secret-not-for-production";
  }
  return candidate;
}
import type { StorageProvider, PutOptions, GetResult, SignedUrlOptions } from "./StorageProvider";

interface MetaSidecar {
  contentType: string | null;
  metadata: Record<string, string>;
  size: number;
  writtenAt: string;
}

/**
 * Filesystem-backed storage for single-node self-host. Files live under
 * `<baseDir>/<key>` with a `<key>.meta.json` sidecar holding the
 * content-type and metadata so behaviour matches S3 (HEAD returns
 * Content-Type without sniffing).
 *
 * `signedGetUrl` returns an HMAC-signed URL that points back at our own
 * /api/v1/storage/:key proxy. The proxy verifies the HMAC + expiry
 * before streaming the file out.
 */
export class FilesystemStorage implements StorageProvider {
  private readonly baseDir: string;
  private readonly publicBaseUrl: string;
  private readonly signingSecret: string;

  constructor(opts?: { baseDir?: string; publicBaseUrl?: string; signingSecret?: string }) {
    this.baseDir = path.resolve(opts?.baseDir ?? process.env.STORAGE_DIR ?? "./data/storage");
    this.publicBaseUrl = (
      opts?.publicBaseUrl ??
      process.env.APP_URL ??
      "http://localhost:3000"
    ).replace(/\/$/, "");
    this.signingSecret = resolveSigningSecret(opts?.signingSecret);
  }

  private absPath(key: string): string {
    this.assertSafeKey(key);
    return path.join(this.baseDir, key);
  }
  private metaPath(key: string): string {
    return `${this.absPath(key)}.meta.json`;
  }
  private assertSafeKey(key: string): void {
    if (!key || key.startsWith("/") || key.includes("..") || key.includes("\\")) {
      throw new ValidationError(`Unsafe storage key: ${key}`);
    }
  }

  async putBuffer(key: string, body: Buffer, opts: PutOptions = {}): Promise<void> {
    const abs = this.absPath(key);
    await fs.mkdir(path.dirname(abs), { recursive: true, mode: 0o755 });
    await fs.writeFile(abs, body, { mode: 0o644 });
    await this.writeMeta(key, body.length, opts);
  }

  async putStream(
    key: string,
    body: Readable,
    opts: PutOptions & { contentLength?: number } = {},
  ): Promise<void> {
    const abs = this.absPath(key);
    await fs.mkdir(path.dirname(abs), { recursive: true, mode: 0o755 });
    const writer = createWriteStream(abs, { mode: 0o644 });
    let size = 0;
    body.on("data", (chunk: Buffer) => {
      size += chunk.length;
    });
    await pipeline(body, writer);
    await this.writeMeta(key, opts.contentLength ?? size, opts);
  }

  async get(key: string): Promise<GetResult> {
    const abs = this.absPath(key);
    const body = await fs.readFile(abs);
    const meta = await this.readMeta(key);
    return {
      body,
      contentType: meta?.contentType ?? undefined,
      size: body.length,
      metadata: meta?.metadata ?? {},
    };
  }

  async getStream(
    key: string,
  ): Promise<{ body: Readable; contentType: string | undefined; size: number }> {
    const abs = this.absPath(key);
    const stat = await fs.stat(abs);
    const meta = await this.readMeta(key);
    return {
      body: createReadStream(abs),
      contentType: meta?.contentType ?? undefined,
      size: stat.size,
    };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await fs.access(this.absPath(key));
      return true;
    } catch {
      return false;
    }
  }

  async delete(key: string): Promise<void> {
    const abs = this.absPath(key);
    await fs.rm(abs, { force: true });
    await fs.rm(this.metaPath(key), { force: true });
  }

  async list(prefix: string, opts: { limit?: number } = {}): Promise<string[]> {
    this.assertSafeKey(prefix);
    const root = path.join(this.baseDir, prefix);
    const cap = opts.limit ?? 1000;
    const out: string[] = [];
    async function walk(dir: string): Promise<void> {
      let entries: Dirent[];
      try {
        entries = await fs.readdir(dir, { withFileTypes: true });
      } catch {
        return;
      }
      for (const entry of entries) {
        if (out.length >= cap) return;
        const abs = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          await walk(abs);
        } else if (entry.isFile() && !entry.name.endsWith(".meta.json")) {
          out.push(abs);
        }
      }
    }
    await walk(root);
    return out.map((p) => path.relative(this.baseDir, p));
  }

  async signedGetUrl(key: string, opts: SignedUrlOptions = {}): Promise<string> {
    this.assertSafeKey(key);
    const exp = Math.floor(Date.now() / 1000) + (opts.expiresInSeconds ?? 600);
    const nonce = randomBytes(8).toString("base64url");
    const payload = `${key}:${exp.toString()}:${nonce}`;
    const sig = createHmac("sha256", this.signingSecret).update(payload).digest("base64url");
    return `${this.publicBaseUrl}/api/v1/storage/${key}?exp=${exp.toString()}&n=${nonce}&s=${sig}`;
  }

  /**
   * Verifies a signed URL (used by the storage proxy route).
   */
  verifySignedUrl(key: string, exp: string, nonce: string, sig: string): boolean {
    const expNum = Number(exp);
    if (!Number.isFinite(expNum) || expNum * 1000 < Date.now()) return false;
    const payload = `${key}:${expNum.toString()}:${nonce}`;
    const expected = createHmac("sha256", this.signingSecret).update(payload).digest();
    // Constant-time comparison — this signature is the sole authorization for the
    // unauthenticated signed-URL read path, so avoid a timing oracle on the HMAC.
    let provided: Buffer;
    try {
      provided = Buffer.from(sig, "base64url");
    } catch {
      return false;
    }
    if (provided.length !== expected.length) return false;
    return timingSafeEqual(expected, provided);
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    try {
      await fs.mkdir(this.baseDir, { recursive: true });
      await fs.access(this.baseDir);
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }

  private async writeMeta(key: string, size: number, opts: PutOptions): Promise<void> {
    const meta: MetaSidecar = {
      contentType: opts.contentType ?? null,
      metadata: opts.metadata ?? {},
      size,
      writtenAt: new Date().toISOString(),
    };
    await fs.writeFile(this.metaPath(key), JSON.stringify(meta), { mode: 0o644 });
  }

  private async readMeta(key: string): Promise<MetaSidecar | null> {
    try {
      const raw = await fs.readFile(this.metaPath(key), "utf8");
      return JSON.parse(raw) as MetaSidecar;
    } catch {
      return null;
    }
  }
}
