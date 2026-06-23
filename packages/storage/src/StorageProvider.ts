/**
 * Tenant-scoped object storage abstraction.
 *
 * Keys MUST start with `tenants/<tenantId>/...` so the bucket policy and
 * the application-level scope agree. Callers use `tenantStorageKey()`
 * helper from ./keys.ts to construct keys safely.
 *
 * Implementations:
 *   • FilesystemStorage — single-node self-host (./data/storage)
 *   • S3Storage — production (AWS S3, MinIO, Cloudflare R2)
 *
 * Signed URLs:
 *   • Filesystem returns a backend-proxied URL (/api/v1/storage/<key>?token=…)
 *   • S3 returns a native presigned URL — for SERVER-TO-SERVER use only.
 *     Do NOT return it to the browser: on self-host the endpoint
 *     (S3_ENDPOINT=http://minio:9000) is internal-only and unreachable from the
 *     browser / Tauri webview. Serve browser-facing objects through the
 *     same-origin proxy /api/v1/storage/<key> or stream them from the owning
 *     route handler via getStream(). See CLAUDE.md invariant #11.
 */
import type { Readable } from "node:stream";

export interface PutOptions {
  contentType?: string;
  cacheControl?: string;
  metadata?: Record<string, string>;
}

export interface GetResult {
  body: Buffer;
  contentType: string | undefined;
  size: number;
  metadata: Record<string, string>;
}

export interface SignedUrlOptions {
  expiresInSeconds?: number;
  responseContentType?: string;
}

export interface StorageProvider {
  putBuffer(key: string, body: Buffer, opts?: PutOptions): Promise<void>;
  putStream(key: string, body: Readable, opts?: PutOptions & { contentLength?: number }): Promise<void>;
  get(key: string): Promise<GetResult>;
  getStream(key: string): Promise<{ body: Readable; contentType: string | undefined; size: number }>;
  exists(key: string): Promise<boolean>;
  delete(key: string): Promise<void>;
  list(prefix: string, opts?: { limit?: number }): Promise<string[]>;
  signedGetUrl(key: string, opts?: SignedUrlOptions): Promise<string>;
  healthCheck?(): Promise<{ ok: boolean; message?: string }>;
}
