import { NextResponse, type NextRequest } from "next/server";
import {
  detectImageMeta,
  generateThumbnail,
  storage,
  tenantStorageKey,
} from "@marquee/storage";
import {
  ANDROID_IMAGE_SPECS,
  IOS_SCREENSHOT_SPECS,
  NotFoundError,
  ValidationError,
  validateAndroidImage,
  validateIosScreenshot,
  type AndroidImageKind,
} from "@marquee/core";
import { prisma, recordAudit } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { requireRole, requireTenant, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { buildAppleStack, buildGoogleStack } from "@/lib/adapters";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// Disable default body parser; we stream the multipart manually
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

// Hard ceiling checked BEFORE buffering the body into memory. Screenshots are
// images (a few MB at most); without this an authenticated EDITOR could POST an
// arbitrarily large file and OOM the server, since Route Handlers impose no cap.
const MAX_SCREENSHOT_BYTES = 16 * 1024 * 1024;

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");

  const { id } = await context.params;

  const formData = await req.formData();
  const file = formData.get("file");
  const locale = formData.get("locale")?.toString();
  const displayType = formData.get("displayType")?.toString();
  const ordinalRaw = formData.get("ordinal")?.toString();

  if (!(file instanceof File)) throw new ValidationError("file is required");
  if (file.size > MAX_SCREENSHOT_BYTES) {
    throw new ValidationError(
      `Image too large (${(file.size / 1024 / 1024).toFixed(1)} MB) — max 16 MB`,
    );
  }
  if (!locale) throw new ValidationError("locale is required");
  if (!displayType) throw new ValidationError("displayType is required");

  const fileBuffer = Buffer.from(await file.arrayBuffer());
  const meta = await detectImageMeta(fileBuffer);
  const ordinal = ordinalRaw ? parseInt(ordinalRaw, 10) : 0;

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");

    // ─── Validate per platform ────────────────────────────────────────
    if (app.platform === "IOS") {
      const v = validateIosScreenshot({
        displayType,
        width: meta.width,
        height: meta.height,
        fileSizeBytes: fileBuffer.length,
        mimeType: file.type,
      });
      if (!v.ok) throw new ValidationError(v.errors.join(" · "), { errors: v.errors });
    } else {
      // Android: displayType is the image kind (phoneScreenshots, icon, ...)
      const kind = displayType as AndroidImageKind;
      if (!ANDROID_IMAGE_SPECS[kind]) {
        throw new ValidationError(`Unknown Android image kind: ${displayType}`);
      }
      const v = validateAndroidImage({
        imageKind: kind,
        width: meta.width,
        height: meta.height,
        fileSizeBytes: fileBuffer.length,
        mimeType: file.type,
      });
      if (!v.ok) throw new ValidationError(v.errors.join(" · "), { errors: v.errors });
    }

    // ─── Compute slot ordinal ─────────────────────────────────────────
    let finalOrdinal = ordinal;
    if (finalOrdinal <= 0) {
      const last = await prisma.screenshot.findFirst({
        where: {
          appId: id,
          locale,
          ...(app.platform === "IOS"
            ? { appleDisplayType: displayType }
            : { googleImageType: displayType }),
        },
        orderBy: { ordinal: "desc" },
      });
      finalOrdinal = (last?.ordinal ?? 0) + 1;
    }

    // ─── Pre-create DB row in UPLOADING state ─────────────────────────
    const row = await prisma.screenshot.create({
      data: {
        tenantId: app.tenantId,
        appId: id,
        locale,
        ...(app.platform === "IOS"
          ? { appleDisplayType: displayType }
          : { googleImageType: displayType }),
        fileName: file.name,
        width: meta.width,
        height: meta.height,
        ordinal: finalOrdinal,
        state: "UPLOADING",
        fileSize: fileBuffer.length,
        createdBy: ctx.user.id,
      },
    });

    // ─── Persist original + thumbnail to object storage ───────────────
    const originalKey = tenantStorageKey(
      app.tenantId,
      "apps",
      id,
      "screenshots",
      row.id,
      `original.${meta.format}`,
    );
    const thumb = await generateThumbnail(fileBuffer, { size: 384, format: "webp" });
    const thumbKey = tenantStorageKey(
      app.tenantId,
      "apps",
      id,
      "screenshots",
      row.id,
      "thumb-384.webp",
    );
    await Promise.all([
      storage.putBuffer(originalKey, fileBuffer, {
        contentType: file.type || "image/png",
        cacheControl: "private, max-age=31536000",
      }),
      storage.putBuffer(thumbKey, thumb.buffer, {
        contentType: thumb.contentType,
        cacheControl: "private, max-age=31536000",
      }),
    ]);

    await prisma.screenshot.update({
      where: { id: row.id },
      data: { storageKey: originalKey, thumbnailKey: thumbKey, state: "COMMITTING" },
    });

    // ─── Upload to Apple/Google ───────────────────────────────────────
    try {
      if (app.platform === "IOS") {
        const stack = await buildAppleStack(app.credentialId);
        // Always upload to an EDITABLE version. The version stored on
        // the App row may point at a READY_FOR_SALE live version (Pull
        // prefers LIVE) which Apple refuses for screenshot writes.
        const editable = await stack.apps.getOrCreateEditableVersion(
          app.storeAppId ?? app.bundleId,
        );
        const result = await stack.screenshots.uploadScreenshot({
          storeAppId: app.storeAppId ?? app.bundleId,
          versionId: editable.id,
          canonicalLocale: locale,
          displayType,
          fileName: file.name,
          fileBuffer,
          contentType: file.type || "image/png",
        });
        // Reflect the editable version on the App row so subsequent
        // operations don't need to re-resolve it.
        if (editable.created || app.versionId !== editable.id) {
          await prisma.app.update({
            where: { id },
            data: {
              versionId: editable.id,
              versionString: editable.versionString,
              status: editable.state,
            },
          });
        }
        await prisma.screenshot.update({
          where: { id: row.id },
          data: {
            appleScreenshotId: result.screenshotId,
            state: result.state === "COMPLETE" ? "COMPLETE" : "PROCESSING",
            uploadedAt: new Date(),
          },
        });
      } else {
        const stack = await buildGoogleStack(app.credentialId);
        const ct = file.type === "image/jpeg" ? "image/jpeg" : "image/png";
        const result = await stack.images.uploadImage({
          packageName: app.bundleId,
          language: locale,
          imageType: displayType as AndroidImageKind,
          fileBuffer,
          contentType: ct,
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
      }

      await recordAudit({
        action: "screenshot.upload",
        target: `app:${id}:screenshot:${row.id}`,
        appId: id,
        outcome: "SUCCESS",
        diff: { locale, displayType, fileName: file.name, ordinal: finalOrdinal },
      });

      return NextResponse.json({
        screenshot: {
          id: row.id,
          state: "PROCESSING",
          ordinal: finalOrdinal,
          thumbnailKey: thumbKey,
        },
      });
    } catch (err: unknown) {
      await prisma.screenshot.update({
        where: { id: row.id },
        data: { state: "UPLOAD_FAILED" },
      });
      await recordAudit({
        action: "screenshot.upload",
        target: `app:${id}:screenshot:${row.id}`,
        appId: id,
        outcome: "FAILURE",
        errorCode: err instanceof Error ? err.name : "UNKNOWN",
        diff: { locale, displayType, fileName: file.name },
      });
      throw err;
    }
  });
});

// Silence unused import (kept for IOS_SCREENSHOT_SPECS extension)
void IOS_SCREENSHOT_SPECS;
