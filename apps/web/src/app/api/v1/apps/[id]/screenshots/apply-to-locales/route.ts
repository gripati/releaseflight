/**
 * Copy the screenshots from a SOURCE locale into one or more TARGET
 * locales for the same display type. For each target we re-upload the
 * binaries via the same 3-step protocol so the store retains independent
 * asset records (and ordinals stay contiguous per slot).
 *
 * Use case: studios that ship the same artwork to every locale.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Locale } from "@marquee/api-contracts";
import { NotFoundError, ValidationError, type AndroidImageKind } from "@marquee/core";
import { storage, tenantStorageKey, generateThumbnail } from "@marquee/storage";
import { prisma, recordAudit } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { requireRole, requireTenant, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { buildAppleStack, buildGoogleStack } from "@/lib/adapters";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const Body = z.object({
  sourceLocale: Locale,
  displayType: z.string().min(1).max(80),
  targetLocales: z.array(Locale).min(1).max(50),
  /** If true, existing screenshots in the target slot are kept; new ones are appended. */
  append: z.boolean().default(false),
});

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id } = await context.params;
  const body = Body.parse(await req.json());

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");

    const sources = await prisma.screenshot.findMany({
      where: {
        appId: id,
        locale: body.sourceLocale,
        ...(app.platform === "IOS"
          ? { appleDisplayType: body.displayType }
          : { googleImageType: body.displayType }),
      },
      orderBy: { ordinal: "asc" },
    });
    if (sources.length === 0) {
      throw new ValidationError(
        `Source locale "${body.sourceLocale}" has no screenshots for ${body.displayType}`,
      );
    }

    const appleStack = app.platform === "IOS" ? await buildAppleStack(app.credentialId) : null;
    const googleStack =
      app.platform === "ANDROID" ? await buildGoogleStack(app.credentialId) : null;

    const targetResults: {
      locale: string;
      copied: number;
      failed: number;
      errors: string[];
    }[] = [];

    for (const targetLocale of body.targetLocales) {
      if (targetLocale === body.sourceLocale) {
        targetResults.push({
          locale: targetLocale,
          copied: 0,
          failed: 0,
          errors: ["same as source"],
        });
        continue;
      }

      // Optionally clear existing screenshots in the target slot
      if (!body.append) {
        const existing = await prisma.screenshot.findMany({
          where: {
            appId: id,
            locale: targetLocale,
            ...(app.platform === "IOS"
              ? { appleDisplayType: body.displayType }
              : { googleImageType: body.displayType }),
          },
        });
        for (const ex of existing) {
          try {
            if (app.platform === "IOS" && ex.appleScreenshotId) {
              await appleStack!.screenshots.deleteScreenshot(ex.appleScreenshotId);
            } else if (app.platform === "ANDROID" && ex.googleImageId && ex.googleImageType) {
              await googleStack!.images.deleteImage({
                packageName: app.bundleId,
                language: targetLocale,
                imageType: ex.googleImageType as AndroidImageKind,
                imageId: ex.googleImageId,
              });
            }
          } catch {
            /* best-effort */
          }
          if (ex.storageKey) await storage.delete(ex.storageKey).catch(() => undefined);
          if (ex.thumbnailKey) await storage.delete(ex.thumbnailKey).catch(() => undefined);
          await prisma.screenshot.delete({ where: { id: ex.id } });
        }
      }

      let copied = 0;
      let failed = 0;
      const errors: string[] = [];
      let ordinal = body.append
        ? ((
            await prisma.screenshot.findFirst({
              where: {
                appId: id,
                locale: targetLocale,
                ...(app.platform === "IOS"
                  ? { appleDisplayType: body.displayType }
                  : { googleImageType: body.displayType }),
              },
              orderBy: { ordinal: "desc" },
            })
          )?.ordinal ?? 0) + 1
        : 1;

      for (const src of sources) {
        try {
          if (!src.storageKey) {
            errors.push(`${src.fileName}: no original on disk`);
            failed += 1;
            continue;
          }
          const original = await storage.get(src.storageKey);
          const row = await prisma.screenshot.create({
            data: {
              tenantId: app.tenantId,
              appId: id,
              locale: targetLocale,
              ...(app.platform === "IOS"
                ? { appleDisplayType: body.displayType }
                : { googleImageType: body.displayType }),
              fileName: src.fileName,
              width: src.width,
              height: src.height,
              ordinal,
              state: "UPLOADING",
              fileSize: original.body.length,
              createdBy: ctx.user.id,
            },
          });
          const originalKey = tenantStorageKey(
            app.tenantId,
            "apps",
            id,
            "screenshots",
            row.id,
            `original.${(original.contentType ?? "image/png").split("/")[1] ?? "png"}`,
          );
          const thumb = await generateThumbnail(original.body, { size: 384 });
          const thumbKey = tenantStorageKey(
            app.tenantId,
            "apps",
            id,
            "screenshots",
            row.id,
            "thumb-384.webp",
          );
          await Promise.all([
            storage.putBuffer(originalKey, original.body, {
              contentType: original.contentType ?? "image/png",
            }),
            storage.putBuffer(thumbKey, thumb.buffer, { contentType: thumb.contentType }),
          ]);
          await prisma.screenshot.update({
            where: { id: row.id },
            data: { storageKey: originalKey, thumbnailKey: thumbKey, state: "COMMITTING" },
          });

          if (app.platform === "IOS") {
            if (!app.versionId) throw new ValidationError("App has no active version");
            const result = await appleStack!.screenshots.uploadScreenshot({
              storeAppId: app.storeAppId ?? app.bundleId,
              versionId: app.versionId,
              canonicalLocale: targetLocale,
              displayType: body.displayType,
              fileName: src.fileName,
              fileBuffer: original.body,
              contentType: original.contentType ?? "image/png",
            });
            await prisma.screenshot.update({
              where: { id: row.id },
              data: {
                appleScreenshotId: result.screenshotId,
                state: result.state === "COMPLETE" ? "COMPLETE" : "PROCESSING",
                uploadedAt: new Date(),
              },
            });
          } else {
            const ct = (original.contentType ?? "image/png") as "image/png" | "image/jpeg";
            const result = await googleStack!.images.uploadImage({
              packageName: app.bundleId,
              language: targetLocale,
              imageType: body.displayType as AndroidImageKind,
              fileBuffer: original.body,
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
          copied += 1;
          ordinal += 1;
        } catch (err: unknown) {
          failed += 1;
          errors.push(`${src.fileName}: ${err instanceof Error ? err.message : String(err)}`);
        }
      }
      targetResults.push({ locale: targetLocale, copied, failed, errors });
    }

    const totalCopied = targetResults.reduce((acc, r) => acc + r.copied, 0);
    const totalFailed = targetResults.reduce((acc, r) => acc + r.failed, 0);
    await recordAudit({
      action: "screenshot.apply-to-locales",
      target: `app:${id}`,
      appId: id,
      outcome: totalFailed === 0 ? "SUCCESS" : totalCopied > 0 ? "PARTIAL" : "FAILURE",
      diff: {
        sourceLocale: body.sourceLocale,
        displayType: body.displayType,
        targetCount: body.targetLocales.length,
        totalCopied,
        totalFailed,
      },
    });

    return NextResponse.json({
      totalCopied,
      totalFailed,
      perLocale: targetResults,
    });
  });
});
