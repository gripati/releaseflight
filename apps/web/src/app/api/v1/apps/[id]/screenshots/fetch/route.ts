import { NextResponse, type NextRequest } from "next/server";
import { storage, tenantStorageKey, generateThumbnail } from "@marquee/storage";
import { NotFoundError } from "@marquee/core";
import { prisma, recordAudit } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { requireRole, requireTenant, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { buildAppleStack, buildGoogleStack } from "@/lib/adapters";

interface RouteContext { params: Promise<{ id: string }> }

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  void ctx;
  const { id } = await context.params;

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");

    if (app.platform === "IOS") {
      if (!app.versionId) {
        return NextResponse.json({ ok: false, message: "No active version" });
      }
      const stack = await buildAppleStack(app.credentialId);
      const grouped = await stack.screenshots.fetchAllScreenshots(app.versionId);

      const discovered = new Set<string>();
      let counted = 0;
      for (const [locale, byType] of grouped) {
        for (const [displayType, items] of byType) {
          discovered.add(displayType);
          let ordinal = 1;
          for (const item of items) {
            counted += 1;
            // The Screenshot model has no composite unique index suitable
            // for upsert(). We identify rows by Apple's stable screenshot
            // id (preferred) and fall back to the slot tuple.
            const existing = await prisma.screenshot.findFirst({
              where: item.id
                ? { appId: id, appleScreenshotId: item.id }
                : { appId: id, locale, appleDisplayType: displayType, ordinal },
              select: { id: true },
            });
            const data = {
              appleScreenshotId: item.id,
              fileName: item.fileName,
              width: item.width,
              height: item.height,
              state: (item.state === "COMPLETE" ? "COMPLETE" : "PROCESSING") as
                | "COMPLETE"
                | "PROCESSING",
              upstreamUrl: item.sourceUrl,
              fileSize: item.fileSize,
              uploadedAt: new Date(),
            };
            if (existing) {
              await prisma.screenshot.update({ where: { id: existing.id }, data });
            } else {
              await prisma.screenshot.create({
                data: {
                  ...data,
                  tenantId: app.tenantId,
                  appId: id,
                  locale,
                  appleDisplayType: displayType,
                  ordinal,
                },
              });
            }

            // Lazy thumbnail — download from Apple (public URL) on first
            // fetch + store. Failures are non-fatal; the UI will fall back
            // to the upstream URL.
            if (item.sourceUrl) {
              try {
                const dl = await fetch(item.sourceUrl);
                if (dl.ok) {
                  const buf = Buffer.from(await dl.arrayBuffer());
                  const thumb = await generateThumbnail(buf, { size: 384 });
                  const key = tenantStorageKey(
                    app.tenantId,
                    "apps",
                    id,
                    "screenshots",
                    `apple-${item.id}`,
                    "thumb-384.webp",
                  );
                  await storage.putBuffer(key, thumb.buffer, {
                    contentType: thumb.contentType,
                    cacheControl: "private, max-age=31536000",
                  });
                  await prisma.screenshot.updateMany({
                    where: { appleScreenshotId: item.id, appId: id },
                    data: { thumbnailKey: key },
                  });
                }
              } catch {
                /* best-effort */
              }
            }
            ordinal += 1;
          }
        }
      }

      await prisma.app.update({
        where: { id },
        data: {
          discoveredScreenshotTypes: [...discovered],
          lastFetchedAt: new Date(),
        },
      });

      await recordAudit({
        action: "screenshot.fetch",
        target: `app:${id}`,
        appId: id,
        outcome: "SUCCESS",
        diff: { count: counted, displayTypes: [...discovered] },
      });
      return NextResponse.json({ ok: true, count: counted, displayTypes: [...discovered] });
    }

    // ANDROID
    const stack = await buildGoogleStack(app.credentialId);
    const langs = app.availableLanguages.length > 0 ? app.availableLanguages : [app.primaryLocale];
    const list = await stack.images.fetchAll(app.bundleId, langs);
    const discovered = new Set<string>();
    let counted = 0;

    for (const img of list) {
      counted += 1;
      discovered.add(img.imageType);
      const row = await prisma.screenshot.findFirst({
        where: { appId: id, googleImageId: img.imageId },
      });
      if (row) {
        await prisma.screenshot.update({
          where: { id: row.id },
          data: { upstreamUrl: img.url, state: "COMPLETE", uploadedAt: new Date() },
        });
      } else {
        await prisma.screenshot.create({
          data: {
            tenantId: app.tenantId,
            appId: id,
            locale: img.language,
            googleImageType: img.imageType,
            googleImageId: img.imageId,
            fileName: `${img.imageType}.png`,
            width: 0,
            height: 0,
            ordinal:
              (await prisma.screenshot.count({
                where: { appId: id, locale: img.language, googleImageType: img.imageType },
              })) + 1,
            state: "COMPLETE",
            upstreamUrl: img.url,
            fileSize: 0,
            uploadedAt: new Date(),
          },
        });
      }
    }

    await prisma.app.update({
      where: { id },
      data: {
        discoveredScreenshotTypes: [...discovered],
        lastFetchedAt: new Date(),
      },
    });

    await recordAudit({
      action: "screenshot.fetch",
      target: `app:${id}`,
      appId: id,
      outcome: "SUCCESS",
      diff: { count: counted, imageTypes: [...discovered] },
    });
    return NextResponse.json({ ok: true, count: counted, imageTypes: [...discovered] });
  });
});
