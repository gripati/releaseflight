/**
 * Apple App Store Connect screenshot adapter.
 *
 * Apple uses a 3-STEP UPLOAD PROTOCOL for screenshots and previews:
 *
 *   1. RESERVE      POST /appScreenshots  body:{ fileName, fileSize, ... }
 *                   Response includes uploadOperations[] — S3 presigned PUT
 *                   URLs (sometimes chunked for large files).
 *
 *   2. UPLOAD       For each operation: PUT bytes at the EXACT offset and
 *                   length, with the headers Apple provides (Content-Type
 *                   etc.). Anything else and Apple's S3 signature fails.
 *
 *   3. COMMIT       PATCH /appScreenshots/:id  body:{ uploaded: true,
 *                   sourceFileChecksum: <md5> }
 *
 * Orphan handling: if a reservation is created but commit never lands,
 * we DELETE the asset so it doesn't show as "pending" in App Store Connect.
 *
 * Fetch is a 4-level hierarchical paginate:
 *   App → AppStoreVersion → AppStoreVersionLocalization → AppScreenshotSet → AppScreenshot
 *
 * Reorder uses Apple's relationships endpoint with the FULL ordered list of
 * screenshot IDs in the desired sequence.
 */

import { createHash } from "node:crypto";
import { Readable } from "node:stream";
import { ConflictError, NotFoundError, UpstreamError, ValidationError } from "../../errors";
import { toAppleLocale } from "../../locale";
import { screenshotToPreviewType } from "../../validation";
import type { AppleClient } from "./AppleClient";

// ───────────────────────────────────────────────────────────────────────
// JSON:API shapes
// ───────────────────────────────────────────────────────────────────────

interface JsonApiVersionLocalization {
  id: string;
  type: "appStoreVersionLocalizations";
  attributes: { locale: string };
}

interface JsonApiScreenshotSet {
  id: string;
  type: "appScreenshotSets";
  attributes: { screenshotDisplayType: string };
}

interface AssetDeliveryState {
  state: "AWAITING_UPLOAD" | "UPLOAD_COMPLETE" | "COMPLETE" | "FAILED" | string;
  errors?: { code?: string; description?: string }[] | null;
  warnings?: { code?: string; description?: string }[] | null;
}

interface JsonApiScreenshot {
  id: string;
  type: "appScreenshots";
  attributes: {
    fileName: string;
    fileSize: number;
    sourceFileChecksum: string | null;
    uploadOperations?: UploadOperation[];
    assetDeliveryState?: AssetDeliveryState;
    imageAsset?: {
      templateUrl: string;
      width: number;
      height: number;
    } | null;
    uploaded: boolean | null;
  };
}

interface JsonApiPreviewSet {
  id: string;
  type: "appPreviewSets";
  attributes: { previewType: string };
}

interface JsonApiPreview {
  id: string;
  type: "appPreviews";
  attributes: {
    fileName: string;
    fileSize: number;
    sourceFileChecksum: string | null;
    uploadOperations?: UploadOperation[];
    assetDeliveryState?: AssetDeliveryState;
    videoUrl?: string | null;
    previewImage?: { templateUrl: string; width: number; height: number } | null;
    mimeType?: string | null;
  };
}

export interface UploadOperationHeader {
  name: string;
  value: string;
}
export interface UploadOperation {
  method: "PUT";
  url: string;
  offset: number;
  length: number;
  requestHeaders: UploadOperationHeader[];
}

// ───────────────────────────────────────────────────────────────────────
// Public types
// ───────────────────────────────────────────────────────────────────────

export interface ScreenshotInfo {
  id: string;
  locale: string;
  displayType: string;
  fileName: string;
  fileSize: number;
  width: number;
  height: number;
  ordinal: number;
  state: string;
  sourceUrl: string | null;
}

export interface UploadScreenshotInput {
  storeAppId: string;
  versionId: string;
  canonicalLocale: string;
  displayType: string;
  fileName: string;
  fileBuffer: Buffer;
  contentType: string;
  /** Stream progress callback (bytesUploaded, totalBytes) */
  onProgress?: (uploaded: number, total: number, step: string) => void;
}

export interface UploadScreenshotResult {
  screenshotId: string;
  state: string;
  assetDeliveryState: AssetDeliveryState | null;
}

export interface ReorderRequest {
  setId: string;
  orderedScreenshotIds: string[];
}

export interface AppPreviewInfo {
  id: string;
  locale: string;
  previewType: string;
  fileName: string;
  fileSize: number;
  ordinal: number;
  state: string;
  videoUrl: string | null;
  posterUrl: string | null;
  mimeType: string | null;
}

export interface UploadAppPreviewInput {
  storeAppId: string;
  versionId: string;
  canonicalLocale: string;
  /** Pass the screenshot displayType (APP_IPHONE_65); we strip the prefix. */
  displayType: string;
  fileName: string;
  fileBuffer: Buffer;
  mimeType: "video/mp4" | "video/quicktime" | "video/x-m4v";
  onProgress?: (uploaded: number, total: number, step: string) => void;
}

// ───────────────────────────────────────────────────────────────────────
// AppleScreenshots
// ───────────────────────────────────────────────────────────────────────

export class AppleScreenshots {
  constructor(private readonly client: AppleClient) {}

  // ─── Fetch ─────────────────────────────────────────────────────────

  async fetchAllScreenshots(
    versionId: string,
  ): Promise<Map<string, Map<string, ScreenshotInfo[]>>> {
    const localeMap = new Map<string, Map<string, ScreenshotInfo[]>>();

    for await (const loc of this.client.paginate<JsonApiVersionLocalization>({
      path: `/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations`,
      query: { limit: 50 },
      pageLimit: 50,
    })) {
      const byType = new Map<string, ScreenshotInfo[]>();
      localeMap.set(loc.attributes.locale, byType);

      for await (const set of this.client.paginate<JsonApiScreenshotSet>({
        path: `/appStoreVersionLocalizations/${encodeURIComponent(loc.id)}/appScreenshotSets`,
        query: { limit: 50 },
        pageLimit: 50,
      })) {
        const screenshots: ScreenshotInfo[] = [];
        byType.set(set.attributes.screenshotDisplayType, screenshots);

        let ordinal = 1;
        for await (const ss of this.client.paginate<JsonApiScreenshot>({
          path: `/appScreenshotSets/${encodeURIComponent(set.id)}/appScreenshots`,
          query: { limit: 10 },
          pageLimit: 5,
        })) {
          screenshots.push({
            id: ss.id,
            locale: loc.attributes.locale,
            displayType: set.attributes.screenshotDisplayType,
            fileName: ss.attributes.fileName,
            fileSize: ss.attributes.fileSize,
            width: ss.attributes.imageAsset?.width ?? 0,
            height: ss.attributes.imageAsset?.height ?? 0,
            ordinal,
            state: ss.attributes.assetDeliveryState?.state ?? "UNKNOWN",
            sourceUrl: this.renderImageUrl(
              ss.attributes.imageAsset ?? null,
              "png",
            ),
          });
          ordinal += 1;
        }
      }
    }
    return localeMap;
  }

  // ─── Upload (3-step) ───────────────────────────────────────────────

  async uploadScreenshot(input: UploadScreenshotInput): Promise<UploadScreenshotResult> {
    const appleLocale = toAppleLocale(input.canonicalLocale);
    input.onProgress?.(0, input.fileBuffer.length, "find-localization");

    // 1. Resolve the localization that belongs to the requested locale
    const loc = await this.findVersionLocalization(input.versionId, appleLocale);
    if (!loc) {
      throw new NotFoundError(`Version localization not found for locale ${appleLocale}`);
    }

    // 2. Find-or-create the screenshot set for this displayType
    input.onProgress?.(0, input.fileBuffer.length, "find-or-create-set");
    let setId = await this.findScreenshotSet(loc.id, input.displayType);
    if (!setId) {
      setId = await this.createScreenshotSet(loc.id, input.displayType);
    }

    // 3. Reserve
    input.onProgress?.(0, input.fileBuffer.length, "reserve");
    const reserved = await this.reserveScreenshot(setId, {
      fileName: input.fileName,
      fileSize: input.fileBuffer.length,
    });

    // 4. Upload chunks (Apple may return ≥1 operations)
    try {
      let uploaded = 0;
      for (const op of reserved.uploadOperations) {
        const slice = input.fileBuffer.subarray(op.offset, op.offset + op.length);
        await this.executeUploadOperation(op, slice);
        uploaded += op.length;
        input.onProgress?.(uploaded, input.fileBuffer.length, "uploading");
      }

      // 5. Commit
      input.onProgress?.(input.fileBuffer.length, input.fileBuffer.length, "committing");
      const checksum = md5Hex(input.fileBuffer);
      await this.commitScreenshot(reserved.id, checksum);

      // 6. Optional state poll (short — Apple takes ~5–30s to process)
      const finalState = await this.pollScreenshotState(reserved.id, 5);
      return {
        screenshotId: reserved.id,
        state: finalState.state,
        assetDeliveryState: finalState.delivery,
      };
    } catch (err: unknown) {
      // Cleanup orphan reservation so the App Store UI stays tidy
      await this.deleteScreenshot(reserved.id).catch(() => {
        /* best-effort */
      });
      throw err;
    }
  }

  // ─── Reorder ───────────────────────────────────────────────────────

  async reorderScreenshots(req: ReorderRequest): Promise<void> {
    await this.client.request({
      method: "PATCH",
      path: `/appScreenshotSets/${encodeURIComponent(req.setId)}/relationships/appScreenshots`,
      body: {
        data: req.orderedScreenshotIds.map((id) => ({
          type: "appScreenshots",
          id,
        })),
      },
    });
  }

  // ─── Delete ────────────────────────────────────────────────────────

  async deleteScreenshot(screenshotId: string): Promise<void> {
    await this.client.request({
      method: "DELETE",
      path: `/appScreenshots/${encodeURIComponent(screenshotId)}`,
    });
  }

  // ─── App Previews (same 3-step protocol, different endpoints) ──────

  async fetchAllPreviews(
    versionId: string,
  ): Promise<Map<string, Map<string, AppPreviewInfo[]>>> {
    const out = new Map<string, Map<string, AppPreviewInfo[]>>();

    for await (const loc of this.client.paginate<JsonApiVersionLocalization>({
      path: `/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations`,
      query: { limit: 50 },
      pageLimit: 50,
    })) {
      const byType = new Map<string, AppPreviewInfo[]>();
      out.set(loc.attributes.locale, byType);

      for await (const set of this.client.paginate<JsonApiPreviewSet>({
        path: `/appStoreVersionLocalizations/${encodeURIComponent(loc.id)}/appPreviewSets`,
        query: { limit: 50 },
        pageLimit: 50,
      })) {
        const previews: AppPreviewInfo[] = [];
        byType.set(set.attributes.previewType, previews);
        let ordinal = 1;
        for await (const pv of this.client.paginate<JsonApiPreview>({
          path: `/appPreviewSets/${encodeURIComponent(set.id)}/appPreviews`,
          query: { limit: 5 },
          pageLimit: 5,
        })) {
          previews.push({
            id: pv.id,
            locale: loc.attributes.locale,
            previewType: set.attributes.previewType,
            fileName: pv.attributes.fileName,
            fileSize: pv.attributes.fileSize,
            ordinal,
            state: pv.attributes.assetDeliveryState?.state ?? "UNKNOWN",
            videoUrl: pv.attributes.videoUrl ?? null,
            posterUrl: this.renderImageUrl(pv.attributes.previewImage ?? null, "png"),
            mimeType: pv.attributes.mimeType ?? null,
          });
          ordinal += 1;
        }
      }
    }
    return out;
  }

  async uploadAppPreview(input: UploadAppPreviewInput): Promise<UploadScreenshotResult> {
    const appleLocale = toAppleLocale(input.canonicalLocale);
    const previewType = screenshotToPreviewType(input.displayType);

    input.onProgress?.(0, input.fileBuffer.length, "find-localization");
    const loc = await this.findVersionLocalization(input.versionId, appleLocale);
    if (!loc) throw new NotFoundError(`Version localization not found for ${appleLocale}`);

    input.onProgress?.(0, input.fileBuffer.length, "find-or-create-preview-set");
    let setId = await this.findPreviewSet(loc.id, previewType);
    if (!setId) setId = await this.createPreviewSet(loc.id, previewType);

    input.onProgress?.(0, input.fileBuffer.length, "reserve");
    const reserved = await this.reservePreview(setId, {
      fileName: input.fileName,
      fileSize: input.fileBuffer.length,
      mimeType: input.mimeType,
    });

    try {
      let uploaded = 0;
      for (const op of reserved.uploadOperations) {
        const slice = input.fileBuffer.subarray(op.offset, op.offset + op.length);
        await this.executeUploadOperation(op, slice);
        uploaded += op.length;
        input.onProgress?.(uploaded, input.fileBuffer.length, "uploading");
      }
      input.onProgress?.(input.fileBuffer.length, input.fileBuffer.length, "committing");
      await this.commitPreview(reserved.id, md5Hex(input.fileBuffer));

      const final = await this.pollPreviewState(reserved.id, 5);
      return {
        screenshotId: reserved.id,
        state: final.state,
        assetDeliveryState: final.delivery,
      };
    } catch (err: unknown) {
      await this.deleteAppPreview(reserved.id).catch(() => {
        /* best-effort */
      });
      throw err;
    }
  }

  async reorderPreviews(req: ReorderRequest): Promise<void> {
    await this.client.request({
      method: "PATCH",
      path: `/appPreviewSets/${encodeURIComponent(req.setId)}/relationships/appPreviews`,
      body: {
        data: req.orderedScreenshotIds.map((id) => ({ type: "appPreviews", id })),
      },
    });
  }

  async deleteAppPreview(previewId: string): Promise<void> {
    await this.client.request({
      method: "DELETE",
      path: `/appPreviews/${encodeURIComponent(previewId)}`,
    });
  }

  // ───────────────────────────────────────────────────────────────────
  // Internal helpers
  // ───────────────────────────────────────────────────────────────────

  private async findVersionLocalization(
    versionId: string,
    appleLocale: string,
  ): Promise<{ id: string } | null> {
    const res = await this.client.request<{ data: JsonApiVersionLocalization[] }>({
      method: "GET",
      path: `/appStoreVersions/${encodeURIComponent(versionId)}/appStoreVersionLocalizations`,
      query: { "filter[locale]": appleLocale, limit: 1 },
    });
    return res.data[0] ? { id: res.data[0].id } : null;
  }

  private async findScreenshotSet(
    versionLocalizationId: string,
    displayType: string,
  ): Promise<string | null> {
    for await (const set of this.client.paginate<JsonApiScreenshotSet>({
      path: `/appStoreVersionLocalizations/${encodeURIComponent(versionLocalizationId)}/appScreenshotSets`,
      query: { limit: 50 },
      pageLimit: 5,
    })) {
      if (set.attributes.screenshotDisplayType === displayType) return set.id;
    }
    return null;
  }

  private async createScreenshotSet(
    versionLocalizationId: string,
    displayType: string,
  ): Promise<string> {
    const res = await this.client.request<{ data: { id: string } }>({
      method: "POST",
      path: "/appScreenshotSets",
      body: {
        data: {
          type: "appScreenshotSets",
          attributes: { screenshotDisplayType: displayType },
          relationships: {
            appStoreVersionLocalization: {
              data: { type: "appStoreVersionLocalizations", id: versionLocalizationId },
            },
          },
        },
      },
    });
    return res.data.id;
  }

  private async findPreviewSet(
    versionLocalizationId: string,
    previewType: string,
  ): Promise<string | null> {
    for await (const set of this.client.paginate<JsonApiPreviewSet>({
      path: `/appStoreVersionLocalizations/${encodeURIComponent(versionLocalizationId)}/appPreviewSets`,
      query: { limit: 50 },
      pageLimit: 5,
    })) {
      if (set.attributes.previewType === previewType) return set.id;
    }
    return null;
  }

  private async createPreviewSet(
    versionLocalizationId: string,
    previewType: string,
  ): Promise<string> {
    const res = await this.client.request<{ data: { id: string } }>({
      method: "POST",
      path: "/appPreviewSets",
      body: {
        data: {
          type: "appPreviewSets",
          attributes: { previewType },
          relationships: {
            appStoreVersionLocalization: {
              data: { type: "appStoreVersionLocalizations", id: versionLocalizationId },
            },
          },
        },
      },
    });
    return res.data.id;
  }

  private async reserveScreenshot(
    setId: string,
    attrs: { fileName: string; fileSize: number },
  ): Promise<{ id: string; uploadOperations: UploadOperation[] }> {
    const res = await this.client.request<{ data: JsonApiScreenshot }>({
      method: "POST",
      path: "/appScreenshots",
      body: {
        data: {
          type: "appScreenshots",
          attributes: attrs,
          relationships: {
            appScreenshotSet: { data: { type: "appScreenshotSets", id: setId } },
          },
        },
      },
    });
    const ops = res.data.attributes.uploadOperations ?? [];
    if (ops.length === 0) {
      throw new UpstreamError("apple", "Reserve returned no uploadOperations", {
        httpStatus: 502,
      });
    }
    return { id: res.data.id, uploadOperations: ops };
  }

  private async reservePreview(
    setId: string,
    attrs: { fileName: string; fileSize: number; mimeType: string },
  ): Promise<{ id: string; uploadOperations: UploadOperation[] }> {
    const res = await this.client.request<{ data: JsonApiPreview }>({
      method: "POST",
      path: "/appPreviews",
      body: {
        data: {
          type: "appPreviews",
          attributes: attrs,
          relationships: {
            appPreviewSet: { data: { type: "appPreviewSets", id: setId } },
          },
        },
      },
    });
    const ops = res.data.attributes.uploadOperations ?? [];
    if (ops.length === 0) {
      throw new UpstreamError("apple", "Reserve returned no uploadOperations (preview)", {
        httpStatus: 502,
      });
    }
    return { id: res.data.id, uploadOperations: ops };
  }

  /**
   * Executes a single uploadOperation. Apple's S3 expects EXACTLY the
   * headers it advertised — including Content-Type. NEVER send our own
   * Authorization header (the URL is presigned).
   */
  private async executeUploadOperation(op: UploadOperation, body: Buffer): Promise<void> {
    if (body.length !== op.length) {
      throw new ValidationError(
        `Body slice length mismatch: ${body.length.toString()} ≠ ${op.length.toString()}`,
      );
    }
    const headers: Record<string, string> = {};
    for (const h of op.requestHeaders) headers[h.name] = h.value;
    // Content-Length is set automatically by fetch when body is a Buffer

    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 5 * 60 * 1000);
    try {
      const res = await fetch(op.url, {
        method: op.method,
        headers,
        body: body as unknown as BodyInit,
        signal: controller.signal,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new UpstreamError(
          "apple",
          `S3 PUT failed at offset=${op.offset.toString()}: ${res.status.toString()} ${text.slice(0, 300)}`,
          { httpStatus: res.status, retryable: res.status >= 500 },
        );
      }
    } finally {
      clearTimeout(timeout);
    }
  }

  private async commitScreenshot(screenshotId: string, sourceFileChecksum: string): Promise<void> {
    await this.client.request({
      method: "PATCH",
      path: `/appScreenshots/${encodeURIComponent(screenshotId)}`,
      body: {
        data: {
          type: "appScreenshots",
          id: screenshotId,
          attributes: { uploaded: true, sourceFileChecksum },
        },
      },
    });
  }

  private async commitPreview(previewId: string, sourceFileChecksum: string): Promise<void> {
    await this.client.request({
      method: "PATCH",
      path: `/appPreviews/${encodeURIComponent(previewId)}`,
      body: {
        data: {
          type: "appPreviews",
          id: previewId,
          attributes: { uploaded: true, sourceFileChecksum },
        },
      },
    });
  }

  private async pollScreenshotState(
    screenshotId: string,
    maxAttempts: number,
  ): Promise<{ state: string; delivery: AssetDeliveryState | null }> {
    for (let i = 0; i < maxAttempts; i += 1) {
      try {
        const res = await this.client.request<{ data: JsonApiScreenshot }>({
          method: "GET",
          path: `/appScreenshots/${encodeURIComponent(screenshotId)}`,
        });
        const delivery = res.data.attributes.assetDeliveryState ?? null;
        const state = delivery?.state ?? "PROCESSING";
        if (state === "COMPLETE" || state === "FAILED") {
          return { state, delivery };
        }
      } catch (err: unknown) {
        if (err instanceof ConflictError) {
          // Apple sometimes returns 409 while assets propagate; retry
        } else {
          throw err;
        }
      }
      await sleep(1500);
    }
    return { state: "PROCESSING", delivery: null };
  }

  private async pollPreviewState(
    previewId: string,
    maxAttempts: number,
  ): Promise<{ state: string; delivery: AssetDeliveryState | null }> {
    for (let i = 0; i < maxAttempts; i += 1) {
      const res = await this.client.request<{ data: JsonApiPreview }>({
        method: "GET",
        path: `/appPreviews/${encodeURIComponent(previewId)}`,
      });
      const delivery = res.data.attributes.assetDeliveryState ?? null;
      const state = delivery?.state ?? "PROCESSING";
      if (state === "COMPLETE" || state === "FAILED") return { state, delivery };
      await sleep(1500);
    }
    return { state: "PROCESSING", delivery: null };
  }

  private renderImageUrl(
    asset: { templateUrl: string; width: number; height: number } | null,
    format: string,
  ): string | null {
    if (!asset?.templateUrl) return null;
    return asset.templateUrl
      .replace("{w}", asset.width.toString())
      .replace("{h}", asset.height.toString())
      .replace("{f}", format);
  }
}

// ───────────────────────────────────────────────────────────────────────
// Internal utils
// ───────────────────────────────────────────────────────────────────────

function md5Hex(buf: Buffer): string {
  return createHash("md5").update(buf).digest("hex");
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

// Compat unused-import silencer
void Readable;
