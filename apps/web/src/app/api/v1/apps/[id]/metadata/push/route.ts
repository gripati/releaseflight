import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Locale } from "@marquee/api-contracts";
import { prisma, recordAudit } from "@marquee/db";
import { NotFoundError, RateLimitError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { buildAppleStack, buildGoogleStack } from "@/lib/adapters";
import { recordMetadataSnapshot } from "@/lib/metadataSnapshot";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const PushRequest = z.object({
  locales: z.array(Locale).optional(),
  includeVersionSettings: z.boolean().default(true),
});

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  void ctx;

  const { id } = await context.params;
  const body = PushRequest.parse(await req.json().catch(() => ({})));

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");

    const targetLocales = body.locales && body.locales.length > 0 ? body.locales : null;
    const locsQuery = targetLocales
      ? { appId: id, locale: { in: targetLocales } }
      : { appId: id, dirty: true };
    const locs = await prisma.appLocalization.findMany({ where: locsQuery });

    if (locs.length === 0) {
      return NextResponse.json({ ok: true, pushed: 0, message: "Nothing to push" });
    }

    if (app.platform === "IOS") {
      const stack = await buildAppleStack(app.credentialId);
      const results = [] as { locale: string; success: boolean; detail: string }[];

      // Push target MUST be an editable version. The version stored on
      // the App row was picked LIVE-first for "Pull from store" — usually
      // READY_FOR_SALE, which Apple refuses to PATCH. Resolve (or
      // auto-create) an editable PREPARE_FOR_SUBMISSION mirroring the
      // Unity reference behaviour.
      const editable = await stack.apps.getOrCreateEditableVersion(app.storeAppId ?? app.bundleId);
      const editableVersionId = editable.id;
      if (editable.created) {
        results.push({
          locale: "(version)",
          success: true,
          detail: `Auto-created editable version ${editable.versionString} (state: ${editable.state})`,
        });
      }

      let rateLimitedCount = 0;
      // Once Apple has rate-limited us AND retrying after the suggested
      // wait still 429'd, treat the bucket as exhausted for the rest of
      // this request — mark every remaining locale rate-limited without
      // waiting another 60s per locale. The user can retry in a minute.
      let rateLimitExhausted = false;
      for (const loc of locs) {
        if (rateLimitExhausted) {
          rateLimitedCount += 1;
          results.push({
            locale: loc.locale,
            success: false,
            detail: "Apple rate-limited — try again in ~60s.",
          });
          continue;
        }
        let r: Awaited<ReturnType<typeof stack.metadata.upsertLocalization>> | null = null;
        let pushErr: Error | null = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            r = await stack.metadata.upsertLocalization({
              storeAppId: app.storeAppId ?? app.bundleId,
              versionId: editableVersionId,
              canonicalLocale: loc.locale,
              fields: {
                name: loc.name,
                subtitle: loc.subtitle,
                privacyPolicyUrl: loc.privacyPolicyUrl,
                description: loc.description,
                keywords: loc.keywords,
                whatsNew: loc.whatsNew,
                promotionalText: loc.promotionalText,
                marketingUrl: loc.marketingUrl,
                supportUrl: loc.supportUrl,
              },
            });
            pushErr = null;
            break;
          } catch (err: unknown) {
            if (err instanceof RateLimitError && attempt === 0) {
              const retryAfter = Math.min(
                70,
                (err.details as { retryAfter?: number } | undefined)?.retryAfter ?? 60,
              );
              await new Promise((resolve) => setTimeout(resolve, retryAfter * 1000));
              continue;
            }
            pushErr = err as Error;
            break;
          }
        }

        if (!r) {
          const isRateLimited = pushErr instanceof RateLimitError;
          if (isRateLimited) {
            rateLimitedCount += 1;
            rateLimitExhausted = true;
          }
          results.push({
            locale: loc.locale,
            success: false,
            detail: isRateLimited
              ? "Apple rate-limited — try again in ~60s. Remaining locales skipped to keep the request fast."
              : (pushErr?.message ?? "Unknown error"),
          });
          continue;
        }

        // A locale only counts as pushed when at least one upstream
        // write actually landed (created or updated). "skipped" means
        // Apple rejected the field (invalid URL, locked state, …) and
        // the user must know — otherwise they think the push succeeded
        // when nothing actually changed.
        const wrote =
          r.versionLocalization.action === "created" ||
          r.versionLocalization.action === "updated" ||
          r.appInfoLocalization.action === "created" ||
          r.appInfoLocalization.action === "updated";
        const allSkipped =
          r.versionLocalization.action === "skipped" && r.appInfoLocalization.action === "skipped";
        const skipReasons: string[] = [];
        if (r.versionLocalization.action === "skipped" && r.versionLocalization.reason) {
          skipReasons.push(`version: ${r.versionLocalization.reason}`);
        }
        if (r.appInfoLocalization.action === "skipped" && r.appInfoLocalization.reason) {
          skipReasons.push(`appInfo: ${r.appInfoLocalization.reason}`);
        }
        results.push({
          locale: loc.locale,
          success: wrote,
          detail: wrote
            ? JSON.stringify({
                version: r.versionLocalization,
                appInfo: r.appInfoLocalization,
              })
            : allSkipped
              ? `Nothing pushed — ${skipReasons.join(" · ")}`
              : skipReasons.join(" · "),
        });
        if (wrote) {
          await prisma.appLocalization.update({
            where: { appId_locale: { appId: id, locale: loc.locale } },
            data: { dirty: false, lastPushedAt: new Date() },
          });
        }
      }

      if (body.includeVersionSettings) {
        try {
          // NEVER send `versionString` on PATCH — Apple rejects it with
          // "The attribute 'versionString' can not be modified" once the
          // version row exists. versionString is set at creation time
          // only (handled inside getOrCreateEditableVersion).
          await stack.metadata.updateVersionSettings({
            versionId: editableVersionId,
            ...(app.releaseType !== null ? { releaseType: app.releaseType } : {}),
            earliestReleaseDate: app.earliestReleaseDate?.toISOString() ?? null,
            ...(app.copyright !== null ? { copyright: app.copyright } : {}),
          });
        } catch (err: unknown) {
          results.push({
            locale: "(version settings)",
            success: false,
            detail: err instanceof Error ? err.message : String(err),
          });
        }
      }

      // Keep the App row aware of the editable version so the screenshots /
      // previews push endpoints can re-use it without another store
      // round-trip.
      await prisma.app.update({
        where: { id },
        data: {
          versionId: editableVersionId,
          versionString: editable.versionString,
          status: editable.state,
        },
      });

      // Update app summary
      const stillDirty = await prisma.appLocalization.count({ where: { appId: id, dirty: true } });
      await prisma.app.update({
        where: { id },
        data: { dirty: stillDirty > 0, lastPushedAt: new Date() },
      });

      const failed = results.filter((r) => !r.success);
      const okLocales = results.filter((r) => r.success).map((r) => r.locale);
      if (okLocales.length > 0) {
        await recordMetadataSnapshot({
          tenantId: ctx.tenant!.id,
          appId: id,
          locales: okLocales,
          pushedById: ctx.user.id,
        });
      }
      await recordAudit({
        action: "metadata.push",
        target: `app:${id}`,
        appId: id,
        outcome:
          failed.length === 0 ? "SUCCESS" : results.length > failed.length ? "PARTIAL" : "FAILURE",
        diff: { locales: results.map((r) => ({ locale: r.locale, success: r.success })) },
      });
      return NextResponse.json({
        ok: true,
        pushed: results.length - failed.length,
        failed: failed.length,
        rateLimited: rateLimitedCount,
        results,
      });
    }

    // ANDROID
    const stack = await buildGoogleStack(app.credentialId);
    const summary = await stack.listings.pushAll({
      packageName: app.bundleId,
      listings: locs.map((l) => ({
        canonicalLocale: l.locale,
        name: l.name ?? "",
        shortDescription: l.shortDescription ?? "",
        description: l.description ?? "",
        videoUrl: l.videoUrl,
      })),
    });

    for (const ok of summary.succeeded) {
      await prisma.appLocalization.update({
        where: { appId_locale: { appId: id, locale: ok.canonical } },
        data: { dirty: false, lastPushedAt: new Date() },
      });
    }
    const stillDirty = await prisma.appLocalization.count({ where: { appId: id, dirty: true } });
    await prisma.app.update({
      where: { id },
      data: { dirty: stillDirty > 0, lastPushedAt: new Date() },
    });

    if (summary.succeeded.length > 0) {
      await recordMetadataSnapshot({
        tenantId: ctx.tenant!.id,
        appId: id,
        locales: summary.succeeded.map((s) => s.canonical),
        pushedById: ctx.user.id,
      });
    }
    await recordAudit({
      action: "metadata.push",
      target: `app:${id}`,
      appId: id,
      outcome:
        summary.failed.length === 0
          ? "SUCCESS"
          : summary.succeeded.length > 0
            ? "PARTIAL"
            : "FAILURE",
      diff: {
        succeeded: summary.succeeded.length,
        failed: summary.failed.length,
        unsupported: summary.unsupported.length,
        strategy: summary.commitStrategy,
      },
    });
    return NextResponse.json({
      ok: true,
      pushed: summary.succeeded.length,
      failed: summary.failed.length,
      unsupported: summary.unsupported,
      strategy: summary.commitStrategy,
    });
  });
});
