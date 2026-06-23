/**
 * Google Play AAB (Android App Bundle) upload + bundle listing.
 *
 * Two endpoints, both behind the publisher edit session:
 *   POST  /upload/.../{packageName}/edits/{editId}/bundles?uploadType=media
 *         (different host: www.googleapis.com/upload/)
 *   GET   /{packageName}/edits/{editId}/bundles
 *
 * Retry policy:
 *   • Up to 3 attempts with 5 / 10 / 20 second exponential backoff
 *   • Non-retryable patterns (401/403, "already exists", "Invalid",
 *     "malformed") fail immediately
 *   • 30-minute timeout per attempt (large AABs)
 *
 * The first successful attempt commits the edit through the smart commit
 * pipeline; failed attempts always discard the edit so orphaned edits
 * don't pile up.
 */
import { UpstreamError } from "../../errors";
import type { GoogleClient } from "./GoogleClient";
import { GoogleEditSession } from "./GoogleEditSession";

const UPLOAD_HOST = "https://www.googleapis.com/upload/androidpublisher/v3/applications";

export interface AabUploadResult {
  versionCode: number;
  sha256: string;
}

export interface BundleInfo {
  versionCode: number;
  sha256: string;
  sha1: string | null;
}

interface BundleResponse {
  versionCode?: number;
  sha256?: string;
  sha1?: string;
}

const NON_RETRYABLE = [
  /^Unauthorized/i,
  /Forbidden/i,
  /not found/i,
  /already exists/i,
  /^Invalid/i,
  /malformed/i,
  /401/, /403/,
];

export class GoogleAab {
  private readonly session: GoogleEditSession;
  constructor(private readonly client: GoogleClient) {
    this.session = new GoogleEditSession(client);
  }

  async listBundles(packageName: string): Promise<BundleInfo[]> {
    return this.session.withReadOnly(packageName, async (editId) => {
      const res = await this.client.request<{ bundles?: BundleResponse[] }>({
        method: "GET",
        path: `/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}/bundles`,
        silent: true,
      });
      return (res.bundles ?? []).map((b) => ({
        versionCode: b.versionCode ?? 0,
        sha256: b.sha256 ?? "",
        sha1: b.sha1 ?? null,
      }));
    });
  }

  async uploadAab(input: {
    packageName: string;
    fileBuffer: Buffer;
    onProgress?: (uploaded: number, total: number, step: string) => void;
  }): Promise<AabUploadResult> {
    const { result } = await this.session.withEdit(input.packageName, async (editId) => {
      let lastError: unknown = null;
      const delays = [0, 5_000, 10_000, 20_000];

      for (let attempt = 0; attempt < 3; attempt += 1) {
        const wait = delays[attempt] ?? 0;
        if (wait > 0) await sleep(wait);
        input.onProgress?.(0, input.fileBuffer.length, `attempt ${(attempt + 1).toString()}/3`);

        try {
          const token = await this.client.getToken();
          const url = `${UPLOAD_HOST}/${encodeURIComponent(input.packageName)}/edits/${encodeURIComponent(editId)}/bundles?uploadType=media`;
          const controller = new AbortController();
          const timeout = setTimeout(() => controller.abort(), 30 * 60 * 1000); // 30 min
          try {
            const res = await fetch(url, {
              method: "POST",
              headers: {
                authorization: `Bearer ${token}`,
                "content-type": "application/octet-stream",
                "content-length": input.fileBuffer.length.toString(),
              },
              body: input.fileBuffer as unknown as BodyInit,
              signal: controller.signal,
            });
            if (!res.ok) {
              const text = await res.text();
              if (NON_RETRYABLE.some((p) => p.test(text))) {
                throw new UpstreamError(
                  "google",
                  `AAB upload non-retryable: HTTP ${res.status.toString()} ${text.slice(0, 300)}`,
                  { httpStatus: res.status },
                );
              }
              lastError = new UpstreamError("google", `AAB upload failed: HTTP ${res.status.toString()} ${text.slice(0, 300)}`, {
                httpStatus: res.status,
                retryable: true,
              });
              continue;
            }
            const data = (await res.json()) as BundleResponse;
            input.onProgress?.(input.fileBuffer.length, input.fileBuffer.length, "committing");
            return { versionCode: data.versionCode ?? 0, sha256: data.sha256 ?? "" };
          } finally {
            clearTimeout(timeout);
          }
        } catch (err: unknown) {
          if (err instanceof UpstreamError && !err.retryable) throw err;
          lastError = err;
        }
      }
      throw lastError instanceof Error
        ? lastError
        : new UpstreamError("google", "AAB upload exhausted retries");
    });
    return result;
  }

  /** Uploads a deobfuscation / native debug symbol file for a given bundle. */
  async uploadDeobfuscation(input: {
    packageName: string;
    versionCode: number;
    fileBuffer: Buffer;
    fileType: "proguard" | "nativeCode";
  }): Promise<void> {
    await this.session.withEdit(input.packageName, async (editId) => {
      const token = await this.client.getToken();
      const url =
        `${UPLOAD_HOST}/${encodeURIComponent(input.packageName)}/edits/${encodeURIComponent(editId)}` +
        `/bundles/${input.versionCode.toString()}/deobfuscationFiles/${input.fileType}?uploadType=media`;
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 15 * 60 * 1000);
      try {
        const res = await fetch(url, {
          method: "POST",
          headers: {
            authorization: `Bearer ${token}`,
            "content-type": "application/octet-stream",
            "content-length": input.fileBuffer.length.toString(),
          },
          body: input.fileBuffer as unknown as BodyInit,
          signal: controller.signal,
        });
        if (!res.ok) {
          const text = await res.text();
          throw new UpstreamError(
            "google",
            `Deobfuscation upload failed: ${text.slice(0, 300)}`,
            { httpStatus: res.status },
          );
        }
      } finally {
        clearTimeout(timeout);
      }
    });
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}
