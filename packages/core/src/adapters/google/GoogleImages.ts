/**
 * Google Play image adapter. Listings + Carousels + single-asset images.
 *
 * Endpoints (under https://androidpublisher.googleapis.com/androidpublisher/v3):
 *   GET    /applications/{pkg}/edits/{editId}/listings/{lang}/{imageType}
 *   DELETE /applications/{pkg}/edits/{editId}/listings/{lang}/{imageType}/{imageId}
 *   POST   /upload/androidpublisher/v3/applications/{pkg}/edits/{editId}/listings/{lang}/{imageType}
 *          (DIFFERENT HOST! www.googleapis.com)
 *
 * Image URLs returned by GET require Bearer auth — they cannot be fetched
 * from the browser. We proxy them through /api/v1/storage if the caller
 * wants to render in the UI.
 */

import type { AndroidImageKind } from "../../validation";
import type { GoogleClient } from "./GoogleClient";
import { GoogleEditSession } from "./GoogleEditSession";

const UPLOAD_HOST = "https://www.googleapis.com/upload/androidpublisher/v3/applications";

interface GoogleImageData {
  id: string;
  url: string;
  sha256: string;
}

export interface GoogleImageInfo {
  language: string;
  imageType: AndroidImageKind;
  imageId: string;
  url: string;
  sha256: string;
}

export interface UploadAndroidImageInput {
  packageName: string;
  language: string;
  imageType: AndroidImageKind;
  fileBuffer: Buffer;
  contentType: "image/png" | "image/jpeg";
  onProgress?: (uploaded: number, total: number, step: string) => void;
}

const ALL_IMAGE_TYPES: AndroidImageKind[] = [
  "phoneScreenshots",
  "sevenInchScreenshots",
  "tenInchScreenshots",
  "tvScreenshots",
  "wearScreenshots",
  "icon",
  "featureGraphic",
  "tvBanner",
  "promoGraphic",
];

export class GoogleImages {
  private readonly session: GoogleEditSession;
  constructor(private readonly client: GoogleClient) {
    this.session = new GoogleEditSession(client);
  }

  async fetchAll(packageName: string, languages: string[]): Promise<GoogleImageInfo[]> {
    return this.session.withReadOnly(packageName, async (editId) => {
      const out: GoogleImageInfo[] = [];
      for (const lang of languages) {
        for (const kind of ALL_IMAGE_TYPES) {
          try {
            const res = await this.client.request<{ images?: GoogleImageData[] }>({
              method: "GET",
              path: `/${encodeURIComponent(packageName)}/edits/${encodeURIComponent(editId)}/listings/${encodeURIComponent(lang)}/${kind}`,
              silent: true,
            });
            for (const img of res.images ?? []) {
              out.push({
                language: lang,
                imageType: kind,
                imageId: img.id,
                url: img.url,
                sha256: img.sha256,
              });
            }
          } catch {
            // 404 ⇒ no images of this kind for this language; skip silently
          }
        }
      }
      return out;
    });
  }

  async uploadImage(input: UploadAndroidImageInput): Promise<GoogleImageInfo> {
    const { result } = await this.session.withEdit(input.packageName, async (editId) => {
      input.onProgress?.(0, input.fileBuffer.length, "uploading");
      const token = await this.client.getToken();
      const uploadUrl =
        `${UPLOAD_HOST}/${encodeURIComponent(input.packageName)}/edits/${encodeURIComponent(editId)}` +
        `/listings/${encodeURIComponent(input.language)}/${input.imageType}?uploadType=media`;

      const res = await fetch(uploadUrl, {
        method: "POST",
        headers: {
          authorization: `Bearer ${token}`,
          "content-type": input.contentType,
          "content-length": input.fileBuffer.length.toString(),
        },
        body: input.fileBuffer as unknown as BodyInit,
      });
      if (!res.ok) {
        const text = await res.text();
        throw new Error(`Google image upload failed (HTTP ${res.status.toString()}): ${text.slice(0, 300)}`);
      }
      const data = (await res.json()) as { image: GoogleImageData };
      input.onProgress?.(input.fileBuffer.length, input.fileBuffer.length, "committing");
      return {
        language: input.language,
        imageType: input.imageType,
        imageId: data.image.id,
        url: data.image.url,
        sha256: data.image.sha256,
      };
    });
    return result;
  }

  async deleteImage(input: {
    packageName: string;
    language: string;
    imageType: AndroidImageKind;
    imageId: string;
  }): Promise<void> {
    await this.session.withEdit(input.packageName, async (editId) => {
      await this.client.request({
        method: "DELETE",
        path:
          `/${encodeURIComponent(input.packageName)}/edits/${encodeURIComponent(editId)}` +
          `/listings/${encodeURIComponent(input.language)}/${input.imageType}/${encodeURIComponent(input.imageId)}`,
      });
    });
  }

  async deleteAllOfType(input: {
    packageName: string;
    language: string;
    imageType: AndroidImageKind;
  }): Promise<void> {
    await this.session.withEdit(input.packageName, async (editId) => {
      await this.client.request({
        method: "DELETE",
        path:
          `/${encodeURIComponent(input.packageName)}/edits/${encodeURIComponent(editId)}` +
          `/listings/${encodeURIComponent(input.language)}/${input.imageType}`,
      });
    });
  }

  /**
   * Streams the bytes of an authenticated Google Play image URL. Used by
   * our /api/v1/storage proxy to render thumbnails in the UI.
   */
  async downloadAuthed(url: string): Promise<Buffer> {
    const token = await this.client.getToken();
    const res = await fetch(url, { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error(`Google image download failed: HTTP ${res.status.toString()}`);
    return Buffer.from(await res.arrayBuffer());
  }
}
