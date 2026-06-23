import { NextResponse, type NextRequest } from "next/server";
import {
  detectVideoMagicBytes,
  IOS_PREVIEW_SPECS,
  MAX_PREVIEW_BYTES,
  NotFoundError,
  ValidationError,
  videoMimeType,
} from "@marquee/core";
import { storage, tenantStorageKey } from "@marquee/storage";
import { prisma, recordAudit } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { requireRole, requireTenant, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { buildAppleStack } from "@/lib/adapters";

interface RouteContext { params: Promise<{ id: string }> }

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id } = await context.params;

  const formData = await req.formData();
  const file = formData.get("file");
  const locale = formData.get("locale")?.toString();
  const previewType = formData.get("previewType")?.toString();
  const ordinalRaw = formData.get("ordinal")?.toString();

  if (!(file instanceof File)) throw new ValidationError("file is required");
  if (!locale) throw new ValidationError("locale is required");
  if (!previewType) throw new ValidationError("previewType is required");

  const fileBuffer = Buffer.from(await file.arrayBuffer());
  if (fileBuffer.length > MAX_PREVIEW_BYTES) {
    throw new ValidationError(
      `Video too large (${(fileBuffer.length / 1024 / 1024).toFixed(1)} MB) — max 500 MB`,
    );
  }

  // Magic-byte sniff. The browser-reported mime is unreliable for QuickTime
  // (.mov) on Windows so we trust the ftyp signature first.
  const magic = detectVideoMagicBytes(fileBuffer.subarray(0, 16));
  if (!magic.ok) {
    throw new ValidationError(magic.message ?? "Not a valid video (missing ISO ftyp marker)");
  }
  const mimeType = videoMimeType(magic, file.type);

  const ordinal = ordinalRaw ? parseInt(ordinalRaw, 10) : 0;

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");
    if (app.platform !== "IOS") {
      throw new ValidationError("App previews are iOS-only (Apple App Store Connect)");
    }

    const spec = IOS_PREVIEW_SPECS[previewType];
    if (!spec) {
      throw new ValidationError(
        `Unknown previewType "${previewType}". Allowed: ${Object.keys(IOS_PREVIEW_SPECS).join(", ")}`,
      );
    }

    // Slot ordinal
    let finalOrdinal = ordinal;
    if (finalOrdinal <= 0) {
      const last = await prisma.appPreview.findFirst({
        where: { appId: id, locale, applePreviewType: previewType },
        orderBy: { ordinal: "desc" },
      });
      finalOrdinal = (last?.ordinal ?? 0) + 1;
      if (finalOrdinal > spec.maxAllowed) {
        throw new ValidationError(`${spec.displayName} allows at most ${spec.maxAllowed.toString()} previews`);
      }
    }

    const row = await prisma.appPreview.create({
      data: {
        tenantId: app.tenantId,
        appId: id,
        locale,
        applePreviewType: previewType,
        fileName: file.name,
        ordinal: finalOrdinal,
        state: "UPLOADING",
        fileSize: fileBuffer.length,
        mimeType,
        createdBy: ctx.user.id,
      },
    });

    const originalKey = tenantStorageKey(
      app.tenantId,
      "apps",
      id,
      "previews",
      row.id,
      `original.${magic.format}`,
    );
    await storage.putBuffer(originalKey, fileBuffer, {
      contentType: mimeType,
      cacheControl: "private, max-age=31536000",
    });
    await prisma.appPreview.update({
      where: { id: row.id },
      data: { storageKey: originalKey, state: "COMMITTING" },
    });

    try {
      const stack = await buildAppleStack(app.credentialId);
      // Always upload to an EDITABLE version (mirrors the screenshot
      // upload + metadata push behaviour — Apple refuses writes against
      // READY_FOR_SALE).
      const editable = await stack.apps.getOrCreateEditableVersion(
        app.storeAppId ?? app.bundleId,
      );
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
      const result = await stack.screenshots.uploadAppPreview({
        storeAppId: app.storeAppId ?? app.bundleId,
        versionId: editable.id,
        canonicalLocale: locale,
        displayType: `APP_${previewType}`,
        fileName: file.name,
        fileBuffer,
        mimeType,
      });
      await prisma.appPreview.update({
        where: { id: row.id },
        data: {
          applePreviewId: result.screenshotId,
          state: result.state === "COMPLETE" ? "COMPLETE" : "PROCESSING",
          uploadedAt: new Date(),
        },
      });

      await recordAudit({
        action: "preview.upload",
        target: `app:${id}:preview:${row.id}`,
        appId: id,
        outcome: "SUCCESS",
        diff: { locale, previewType, fileName: file.name, ordinal: finalOrdinal, mimeType },
      });

      return NextResponse.json({
        preview: {
          id: row.id,
          state: result.state === "COMPLETE" ? "COMPLETE" : "PROCESSING",
          ordinal: finalOrdinal,
          storageKey: originalKey,
        },
      });
    } catch (err: unknown) {
      await prisma.appPreview.update({
        where: { id: row.id },
        data: { state: "UPLOAD_FAILED" },
      });
      await recordAudit({
        action: "preview.upload",
        target: `app:${id}:preview:${row.id}`,
        appId: id,
        outcome: "FAILURE",
        errorCode: err instanceof Error ? err.name : "UNKNOWN",
        diff: { locale, previewType, fileName: file.name },
      });
      throw err;
    }
  });
});
