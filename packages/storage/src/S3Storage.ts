import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  HeadObjectCommand,
  DeleteObjectCommand,
  ListObjectsV2Command,
} from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import type { Readable } from "node:stream";
import type { StorageProvider, PutOptions, GetResult, SignedUrlOptions } from "./StorageProvider";

interface S3StorageOptions {
  bucket: string;
  region?: string;
  endpoint?: string;
  forcePathStyle?: boolean;
  accessKeyId?: string;
  secretAccessKey?: string;
}

/**
 * S3-compatible storage (AWS S3, MinIO, Cloudflare R2). Returns native
 * presigned URLs from `signedGetUrl()` so the browser can fetch directly.
 */
export class S3Storage implements StorageProvider {
  private readonly client: S3Client;
  private readonly bucket: string;

  constructor(opts: S3StorageOptions) {
    this.bucket = opts.bucket;
    this.client = new S3Client({
      region: opts.region ?? process.env.S3_REGION ?? "us-east-1",
      ...(opts.endpoint && { endpoint: opts.endpoint }),
      forcePathStyle: opts.forcePathStyle ?? true,
      ...(opts.accessKeyId &&
        opts.secretAccessKey && {
          credentials: { accessKeyId: opts.accessKeyId, secretAccessKey: opts.secretAccessKey },
        }),
    });
  }

  async putBuffer(key: string, body: Buffer, opts: PutOptions = {}): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentType: opts.contentType,
        CacheControl: opts.cacheControl,
        Metadata: opts.metadata,
      }),
    );
  }

  async putStream(
    key: string,
    body: Readable,
    opts: PutOptions & { contentLength?: number } = {},
  ): Promise<void> {
    await this.client.send(
      new PutObjectCommand({
        Bucket: this.bucket,
        Key: key,
        Body: body,
        ContentLength: opts.contentLength,
        ContentType: opts.contentType,
        CacheControl: opts.cacheControl,
        Metadata: opts.metadata,
      }),
    );
  }

  async get(key: string): Promise<GetResult> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const body = res.Body as Readable | undefined;
    if (!body) throw new Error(`S3 GetObject returned no body for ${key}`);
    const buf = await streamToBuffer(body);
    return {
      body: buf,
      contentType: res.ContentType,
      size: buf.length,
      metadata: res.Metadata ?? {},
    };
  }

  async getStream(
    key: string,
  ): Promise<{ body: Readable; contentType: string | undefined; size: number }> {
    const res = await this.client.send(new GetObjectCommand({ Bucket: this.bucket, Key: key }));
    const body = res.Body as Readable | undefined;
    if (!body) throw new Error(`S3 GetObject returned no body for ${key}`);
    return {
      body,
      contentType: res.ContentType,
      size: res.ContentLength ?? 0,
    };
  }

  async exists(key: string): Promise<boolean> {
    try {
      await this.client.send(new HeadObjectCommand({ Bucket: this.bucket, Key: key }));
      return true;
    } catch (err: unknown) {
      const e = err as { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.name === "NotFound" || e.$metadata?.httpStatusCode === 404) return false;
      throw err;
    }
  }

  async delete(key: string): Promise<void> {
    await this.client.send(new DeleteObjectCommand({ Bucket: this.bucket, Key: key }));
  }

  async list(prefix: string, opts: { limit?: number } = {}): Promise<string[]> {
    const res = await this.client.send(
      new ListObjectsV2Command({
        Bucket: this.bucket,
        Prefix: prefix,
        MaxKeys: opts.limit ?? 1000,
      }),
    );
    return (res.Contents ?? []).map((c) => c.Key ?? "").filter(Boolean);
  }

  async signedGetUrl(key: string, opts: SignedUrlOptions = {}): Promise<string> {
    return getSignedUrl(
      this.client,
      new GetObjectCommand({
        Bucket: this.bucket,
        Key: key,
        ...(opts.responseContentType && { ResponseContentType: opts.responseContentType }),
      }),
      { expiresIn: opts.expiresInSeconds ?? 600 },
    );
  }

  async healthCheck(): Promise<{ ok: boolean; message?: string }> {
    try {
      await this.client.send(new ListObjectsV2Command({ Bucket: this.bucket, MaxKeys: 1 }));
      return { ok: true };
    } catch (err: unknown) {
      return { ok: false, message: err instanceof Error ? err.message : String(err) };
    }
  }
}

async function streamToBuffer(stream: Readable): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) {
    chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : Buffer.from(chunk as Uint8Array));
  }
  return Buffer.concat(chunks);
}
