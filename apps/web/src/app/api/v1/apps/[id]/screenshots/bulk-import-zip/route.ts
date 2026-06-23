/**
 * Bulk screenshot import from a ZIP archive. Expected directory layout:
 *
 *   <root>/<locale>/<displayType>/<NN>.{png|jpg|jpeg}
 *
 *   e.g.  zip://en-US/APP_IPHONE_65/01.png
 *         zip://tr/APP_IPHONE_65/02.png
 *
 * The route:
 *   1. Parses the ZIP entirely in memory (jszip)
 *   2. Validates each file against the platform spec
 *   3. Persists original + thumbnail to object storage
 *   4. Uploads to Apple/Google sequentially per slot (so ordinals stay
 *      contiguous). Failures are reported per-file; valid uploads
 *      proceed even when others fail.
 */
import { NextResponse, type NextRequest } from "next/server";
import JSZip from "jszip";
import {
  ANDROID_IMAGE_SPECS,
  IOS_SCREENSHOT_SPECS,
  NotFoundError,
  ValidationError,
  validateAndroidImage,
  validateIosScreenshot,
  type AndroidImageKind,
} from "@marquee/core";
import { detectImageMeta, generateThumbnail, storage, tenantStorageKey } from "@marquee/storage";
import { prisma, recordAudit } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { requireRole, requireTenant, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { buildAppleStack, buildGoogleStack } from "@/lib/adapters";

interface RouteContext {
  params: Promise<{ id: string }>;
}

interface FileResult {
  path: string;
  locale: string;
  displayType: string;
  status: "ok" | "skipped" | "failed";
  message?: string;
  ordinal?: number;
  screenshotId?: string;
}

const MAX_ZIP_BYTES = 500 * 1024 * 1024; // 500 MB archive
const MAX_FILES = 500;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id } = await context.params;

  const formData = await req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) throw new ValidationError("file (zip) is required");
  if (file.size > MAX_ZIP_BYTES) {
    throw new ValidationError(
      `ZIP too large (${(file.size / 1024 / 1024).toFixed(1)} MB) — max 500 MB`,
    );
  }

  const zipBuf = Buffer.from(await file.arrayBuffer());
  const zip = await JSZip.loadAsync(zipBuf);
  const entries = Object.values(zip.files).filter((e) => !e.dir);
  if (entries.length === 0) throw new ValidationError("ZIP is empty");
  if (entries.length > MAX_FILES) {
    throw new ValidationError(
      `Too many files in archive (${entries.length.toString()}; max ${MAX_FILES.toString()})`,
    );
  }

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");

    // Group by (locale, displayType) so ordinals are contiguous per slot
    const grouped = new Map<
      string,
      { locale: string; displayType: string; files: typeof entries }
    >();
    const results: FileResult[] = [];

    for (const entry of entries) {
      const parts = entry.name.split("/").filter((p) => p && p !== "." && !p.startsWith("__"));
      if (parts.length < 3) {
        results.push({
          path: entry.name,
          locale: "?",
          displayType: "?",
          status: "skipped",
          message: "Expected layout: <locale>/<displayType>/<file>",
        });
        continue;
      }
      const locale = parts[0]!;
      const displayType = parts[1]!;
      const fileName = parts.slice(2).join("/");
      const lower = fileName.toLowerCase();
      if (!/\.(png|jpe?g)$/i.test(lower)) {
        results.push({
          path: entry.name,
          locale,
          displayType,
          status: "skipped",
          message: "Only .png / .jpg / .jpeg supported",
        });
        continue;
      }
      const slotKey = `${locale}__${displayType}`;
      let g = grouped.get(slotKey);
      if (!g) {
        g = { locale, displayType, files: [] };
        grouped.set(slotKey, g);
      }
      g.files.push(entry);
    }

    // Sort files inside each slot by name (so 01.png, 02.png … keep order)
    for (const g of grouped.values()) {
      g.files.sort((a, b) => a.name.localeCompare(b.name));
    }

    const appleStack = app.platform === "IOS" ? await buildAppleStack(app.credentialId) : null;
    const googleStack =
      app.platform === "ANDROID" ? await buildGoogleStack(app.credentialId) : null;

    for (const slot of grouped.values()) {
      // Starting ordinal — next free slot
      const last = await prisma.screenshot.findFirst({
        where: {
          appId: id,
          locale: slot.locale,
          ...(app.platform === "IOS"
            ? { appleDisplayType: slot.displayType }
            : { googleImageType: slot.displayType }),
        },
        orderBy: { ordinal: "desc" },
      });
      let nextOrdinal = (last?.ordinal ?? 0) + 1;

      for (const entry of slot.files) {
        const fileName = entry.name.split("/").pop()!;
        try {
          const buf = Buffer.from(await entry.async("nodebuffer"));
          const meta = await detectImageMeta(buf);
          const mime = fileName.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";

          if (app.platform === "IOS") {
            const v = validateIosScreenshot({
              displayType: slot.displayType,
              width: meta.width,
              height: meta.height,
              fileSizeBytes: buf.length,
              mimeType: mime,
            });
            if (!v.ok) {
              results.push({
                path: entry.name,
                locale: slot.locale,
                displayType: slot.displayType,
                status: "failed",
                message: v.errors.join("; "),
              });
              continue;
            }
          } else {
            const kind = slot.displayType as AndroidImageKind;
            if (!ANDROID_IMAGE_SPECS[kind]) {
              results.push({
                path: entry.name,
                locale: slot.locale,
                displayType: slot.displayType,
                status: "failed",
                message: `Unknown Android image kind: ${slot.displayType}`,
              });
              continue;
            }
            const v = validateAndroidImage({
              imageKind: kind,
              width: meta.width,
              height: meta.height,
              fileSizeBytes: buf.length,
              mimeType: mime,
            });
            if (!v.ok) {
              results.push({
                path: entry.name,
                locale: slot.locale,
                displayType: slot.displayType,
                status: "failed",
                message: v.errors.join("; "),
              });
              continue;
            }
          }

          // Pre-create DB row
          const row = await prisma.screenshot.create({
            data: {
              tenantId: app.tenantId,
              appId: id,
              locale: slot.locale,
              ...(app.platform === "IOS"
                ? { appleDisplayType: slot.displayType }
                : { googleImageType: slot.displayType }),
              fileName,
              width: meta.width,
              height: meta.height,
              ordinal: nextOrdinal,
              state: "UPLOADING",
              fileSize: buf.length,
              createdBy: ctx.user.id,
            },
          });

          // Storage
          const originalKey = tenantStorageKey(
            app.tenantId,
            "apps",
            id,
            "screenshots",
            row.id,
            `original.${meta.format}`,
          );
          const thumb = await generateThumbnail(buf, { size: 384 });
          const thumbKey = tenantStorageKey(
            app.tenantId,
            "apps",
            id,
            "screenshots",
            row.id,
            "thumb-384.webp",
          );
          await Promise.all([
            storage.putBuffer(originalKey, buf, { contentType: mime }),
            storage.putBuffer(thumbKey, thumb.buffer, { contentType: thumb.contentType }),
          ]);
          await prisma.screenshot.update({
            where: { id: row.id },
            data: { storageKey: originalKey, thumbnailKey: thumbKey, state: "COMMITTING" },
          });

          // Upload to store
          if (app.platform === "IOS") {
            if (!app.versionId) throw new ValidationError("App has no active version");
            const result = await appleStack!.screenshots.uploadScreenshot({
              storeAppId: app.storeAppId ?? app.bundleId,
              versionId: app.versionId,
              canonicalLocale: slot.locale,
              displayType: slot.displayType,
              fileName,
              fileBuffer: buf,
              contentType: mime,
            });
            await prisma.screenshot.update({
              where: { id: row.id },
              data: {
                appleScreenshotId: result.screenshotId,
                state: result.state === "COMPLETE" ? "COMPLETE" : "PROCESSING",
                uploadedAt: new Date(),
              },
            });
            results.push({
              path: entry.name,
              locale: slot.locale,
              displayType: slot.displayType,
              status: "ok",
              ordinal: nextOrdinal,
              screenshotId: row.id,
            });
          } else {
            const result = await googleStack!.images.uploadImage({
              packageName: app.bundleId,
              language: slot.locale,
              imageType: slot.displayType as AndroidImageKind,
              fileBuffer: buf,
              contentType: mime,
            });
            await prisma.screenshot.update({
              where: { id: row.id },
              data: {
                googleImageId: result.imageId,
                upstreamUrl: result.url,
                state: "COMPLETE",
                uploadedAt: new Date(),
              },
            });
            results.push({
              path: entry.name,
              locale: slot.locale,
              displayType: slot.displayType,
              status: "ok",
              ordinal: nextOrdinal,
              screenshotId: row.id,
            });
          }

          nextOrdinal += 1;
        } catch (err: unknown) {
          results.push({
            path: entry.name,
            locale: slot.locale,
            displayType: slot.displayType,
            status: "failed",
            message: err instanceof Error ? err.message : String(err),
          });
        }
      }
    }

    const ok = results.filter((r) => r.status === "ok").length;
    const failed = results.filter((r) => r.status === "failed").length;
    const skipped = results.filter((r) => r.status === "skipped").length;
    await recordAudit({
      action: "screenshot.bulk-import-zip",
      target: `app:${id}`,
      appId: id,
      outcome: failed === 0 ? "SUCCESS" : ok > 0 ? "PARTIAL" : "FAILURE",
      diff: { ok, failed, skipped },
    });

    return NextResponse.json({ ok, failed, skipped, results });
  });
});

// Silence unused imports
void IOS_SCREENSHOT_SPECS;
