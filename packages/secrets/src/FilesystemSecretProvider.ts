import fs from "node:fs/promises";
import path from "node:path";
import { ValidationError } from "@marquee/core";
import type { SecretMaterial, SecretProvider, SecretKind } from "./SecretProvider";
import { loadMasterKey, isEncrypted, encryptSecret, decryptSecret } from "./envelope";

const SCHEME = "filesystem";
const REF_RE = /^filesystem:\/\/\/tenants\/([0-9a-f-]{36})\/credentials\/([0-9a-f-]{36})$/i;

interface MetadataFile {
  kind: SecretKind;
  /** Legacy plaintext metadata (read-only back-compat). New writes use encMetadata. */
  metadata?: Record<string, string>;
  /** Envelope-encrypted JSON of the metadata Record — holds keystore passwords/alias etc. */
  encMetadata?: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * Stores secrets as files on disk with strict 0600 permissions inside a
 * per-tenant directory:
 *
 *   <baseDir>/tenants/<tenantId>/credentials/<credId>.content
 *   <baseDir>/tenants/<tenantId>/credentials/<credId>.meta.json
 *
 * Directories are chmod 0700; files are chmod 0600. The base dir is set
 * via constructor or SECRETS_DIR env. Suitable for single-node self-host;
 * use AWS Secrets Manager for multi-node production.
 */
export class FilesystemSecretProvider implements SecretProvider {
  private readonly baseDir: string;
  private readonly masterKey: Buffer | null;

  constructor(baseDir?: string) {
    const dir = baseDir ?? process.env.SECRETS_DIR ?? "./data/secrets";
    this.baseDir = path.resolve(dir);
    this.masterKey = loadMasterKey();
    // Encryption at rest is mandatory in production: the filesystem provider
    // holds every tenant's signing/publishing credentials, so refuse to run
    // without a configured KEK rather than persist them as plaintext. This is a
    // RUNTIME requirement — skip it during Next's production BUILD phase, which
    // merely imports route modules and never reads/writes secrets.
    const isNextBuild = process.env.NEXT_PHASE === "phase-production-build";
    if (!this.masterKey && process.env.NODE_ENV === "production" && !isNextBuild) {
      throw new Error(
        "SECRETS_ENCRYPTION_KEY is required in production: refusing to store credentials unencrypted at rest.",
      );
    }
  }

  /** AEAD additional data binds a blob to its tenant+credential slot. */
  private aad(tenantId: string, credentialId: string, field: "content" | "meta"): string {
    return `${tenantId}:${credentialId}:${field}`;
  }

  async put(tenantId: string, credentialId: string, material: SecretMaterial): Promise<string> {
    this.assertUuid(tenantId, "tenantId");
    this.assertUuid(credentialId, "credentialId");

    const dir = this.tenantCredDir(tenantId);
    await fs.mkdir(dir, { recursive: true, mode: 0o700 });

    const contentPath = path.join(dir, `${credentialId}.content`);
    const metaPath = path.join(dir, `${credentialId}.meta.json`);

    const now = new Date().toISOString();
    let createdAt = now;
    try {
      const existing = JSON.parse(await fs.readFile(metaPath, "utf8")) as MetadataFile;
      createdAt = existing.createdAt;
    } catch {
      // First write
    }

    const content = this.masterKey
      ? encryptSecret(material.content, this.masterKey, this.aad(tenantId, credentialId, "content"))
      : material.content;

    const meta: MetadataFile = {
      kind: material.kind,
      createdAt,
      updatedAt: now,
    };
    if (material.metadata) {
      if (this.masterKey) {
        meta.encMetadata = encryptSecret(
          JSON.stringify(material.metadata),
          this.masterKey,
          this.aad(tenantId, credentialId, "meta"),
        );
      } else {
        meta.metadata = material.metadata;
      }
    }

    await fs.writeFile(contentPath, content, { mode: 0o600 });
    await fs.writeFile(metaPath, JSON.stringify(meta, null, 2), { mode: 0o600 });

    return this.buildRef(tenantId, credentialId);
  }

  async get(secretRef: string): Promise<SecretMaterial> {
    const { tenantId, credentialId } = this.parseRef(secretRef);
    const dir = this.tenantCredDir(tenantId);
    const contentPath = path.join(dir, `${credentialId}.content`);
    const metaPath = path.join(dir, `${credentialId}.meta.json`);

    const [rawContent, metaRaw] = await Promise.all([
      fs.readFile(contentPath, "utf8"),
      fs.readFile(metaPath, "utf8"),
    ]);
    const meta = JSON.parse(metaRaw) as MetadataFile;

    // Decrypt content (or pass through legacy plaintext written before
    // encryption was enabled — re-encrypted on the next put()).
    let content = rawContent;
    if (isEncrypted(rawContent)) {
      if (!this.masterKey) {
        throw new Error("SECRETS_ENCRYPTION_KEY is required to read this encrypted secret.");
      }
      content = decryptSecret(
        rawContent,
        this.masterKey,
        this.aad(tenantId, credentialId, "content"),
      );
    }

    // Metadata: prefer the encrypted field, fall back to legacy plaintext.
    let metadata: Record<string, string> | undefined;
    if (meta.encMetadata) {
      if (!this.masterKey) {
        throw new Error("SECRETS_ENCRYPTION_KEY is required to read this encrypted secret.");
      }
      metadata = JSON.parse(
        decryptSecret(meta.encMetadata, this.masterKey, this.aad(tenantId, credentialId, "meta")),
      ) as Record<string, string>;
    } else if (meta.metadata) {
      metadata = meta.metadata;
    }

    return {
      kind: meta.kind,
      content,
      ...(metadata && { metadata }),
    };
  }

  async delete(secretRef: string): Promise<void> {
    const { tenantId, credentialId } = this.parseRef(secretRef);
    const dir = this.tenantCredDir(tenantId);
    const contentPath = path.join(dir, `${credentialId}.content`);
    const metaPath = path.join(dir, `${credentialId}.meta.json`);

    // Best-effort secure delete: overwrite with zeros, then unlink
    for (const p of [contentPath, metaPath]) {
      try {
        const stat = await fs.stat(p);
        if (stat.size > 0 && stat.size < 4 * 1024 * 1024) {
          await fs.writeFile(p, Buffer.alloc(stat.size), { mode: 0o600 });
        }
        await fs.unlink(p);
      } catch (err: unknown) {
        const e = err as NodeJS.ErrnoException;
        if (e.code !== "ENOENT") throw err;
      }
    }
  }

  async listForTenant(tenantId: string): Promise<string[]> {
    this.assertUuid(tenantId, "tenantId");
    const dir = this.tenantCredDir(tenantId);
    let entries: string[];
    try {
      entries = await fs.readdir(dir);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException;
      if (e.code === "ENOENT") return [];
      throw err;
    }
    return entries
      .filter((f) => f.endsWith(".content"))
      .map((f) => this.buildRef(tenantId, f.replace(/\.content$/, "")));
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    try {
      await fs.mkdir(this.baseDir, { recursive: true, mode: 0o700 });
      await fs.access(this.baseDir);
      return { ok: true };
    } catch (err: unknown) {
      return {
        ok: false,
        message: err instanceof Error ? err.message : String(err),
      };
    }
  }

  // ──────────────────────────────────────────────────────────────────────
  // Helpers
  // ──────────────────────────────────────────────────────────────────────

  private tenantCredDir(tenantId: string): string {
    return path.join(this.baseDir, "tenants", tenantId, "credentials");
  }

  private buildRef(tenantId: string, credentialId: string): string {
    return `${SCHEME}:///tenants/${tenantId}/credentials/${credentialId}`;
  }

  private parseRef(ref: string): { tenantId: string; credentialId: string } {
    const m = REF_RE.exec(ref);
    if (!m?.[1] || !m[2]) {
      throw new ValidationError(`Invalid secret ref for filesystem provider: ${ref}`);
    }
    return { tenantId: m[1], credentialId: m[2] };
  }

  private assertUuid(value: string, name: string): void {
    if (!/^[0-9a-f-]{36}$/i.test(value)) {
      throw new ValidationError(`${name} must be a UUID, got "${value}"`);
    }
  }
}
