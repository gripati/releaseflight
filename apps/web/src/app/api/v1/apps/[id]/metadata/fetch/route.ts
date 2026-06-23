import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma, recordAudit, tenantTransaction } from "@marquee/db";
import { ConflictError, NotFoundError, ValidationError } from "@marquee/core";
import { enqueue } from "@marquee/jobs";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { buildAppleStack, buildGoogleStack } from "@/lib/adapters";
import { syncKeywordsFromMetadata } from "@/lib/keywordsFromMetadata";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const FetchRequest = z.object({
  overwriteLocalEdits: z.boolean().default(false),
});

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  void ctx;

  const { id } = await context.params;
  const body = FetchRequest.parse(await req.json().catch(() => ({})));

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");

    if (!body.overwriteLocalEdits) {
      const dirty = await prisma.appLocalization.findMany({
        where: { appId: id, dirty: true },
        select: { locale: true },
      });
      if (dirty.length > 0) {
        throw new ConflictError("Local edits exist; pass overwriteLocalEdits=true to discard them", {
          dirtyLocales: dirty.map((d) => d.locale),
        });
      }
    }

    if (app.platform === "IOS") {
      const stack = await buildAppleStack(app.credentialId);
      const details = await stack.apps.getFullDetails(app.storeAppId ?? app.bundleId);
      if (!details) throw new NotFoundError("App not found in App Store Connect");

      const [appInfo, versionLocs] = await Promise.all([
        stack.metadata.fetchAppInfoLocalizations(details.storeAppId),
        details.versionId
          ? stack.metadata.fetchVersionLocalizations(details.versionId)
          : Promise.resolve(new Map()),
      ]);
      const merged = stack.metadata.mergeLocalizations(appInfo, versionLocs);

      // UPSERT all locales, mark non-dirty
      await tenantTransaction(async (tx) => {
        await tx.app.update({
          where: { id },
          data: {
            storeAppId: details.storeAppId,
            appName: details.name,
            primaryLocale: details.primaryLocale,
            versionId: details.versionId,
            versionString: details.versionString,
            status: details.status,
            releaseType: details.releaseType,
            earliestReleaseDate: details.earliestReleaseDate
              ? new Date(details.earliestReleaseDate)
              : null,
            copyright: details.copyright,
            availableLanguages: merged.map((m) => m.locale),
            lastFetchedAt: new Date(),
            dirty: false,
          },
        });
        for (const m of merged) {
          await tx.appLocalization.upsert({
            where: { appId_locale: { appId: id, locale: m.locale } },
            create: {
              appId: id,
              tenantId: app.tenantId,
              locale: m.locale,
              appleAppInfoLocalizationId: m.appInfoLocalizationId,
              appleVersionLocalizationId: m.versionLocalizationId,
              name: m.name,
              subtitle: m.subtitle,
              description: m.description,
              keywords: m.keywords,
              whatsNew: m.whatsNew,
              promotionalText: m.promotionalText,
              marketingUrl: m.marketingUrl,
              supportUrl: m.supportUrl,
              privacyPolicyUrl: m.privacyPolicyUrl,
              dirty: false,
              lastFetchedAt: new Date(),
            },
            update: {
              appleAppInfoLocalizationId: m.appInfoLocalizationId,
              appleVersionLocalizationId: m.versionLocalizationId,
              name: m.name,
              subtitle: m.subtitle,
              description: m.description,
              keywords: m.keywords,
              whatsNew: m.whatsNew,
              promotionalText: m.promotionalText,
              marketingUrl: m.marketingUrl,
              supportUrl: m.supportUrl,
              privacyPolicyUrl: m.privacyPolicyUrl,
              dirty: false,
              lastFetchedAt: new Date(),
            },
          });
        }
      });

      const keywordImport = await syncKeywordsFromMetadata({
        tenantId: app.tenantId,
        appId: id,
        userId: ctx.user.id,
      }).catch(() => ({ importedCount: 0, skippedExisting: 0, perLocale: [] }));

      // First-time onboarding signal: if THIS fetch imported keywords
      // we haven't seen before AND no Astro analyze has ever run for
      // this app, kick off the initial autopilot so the user lands on
      // a dashboard that already shows opportunities — not an empty
      // "run Astro now" prompt.
      const initialAstroEnqueueId = await maybeEnqueueInitialAstro({
        tenantId: app.tenantId,
        userId: ctx.user.id,
        appId: id,
        importedThisRun: keywordImport.importedCount,
      });

      await recordAudit({
        action: "metadata.fetch",
        target: `app:${id}`,
        appId: id,
        outcome: "SUCCESS",
        diff: {
          locales: merged.length,
          keywordsImported: keywordImport.importedCount,
          initialAstroEnqueueId,
        },
      });
      return NextResponse.json({
        ok: true,
        locales: merged.length,
        keywordsImported: keywordImport.importedCount,
        initialAstroEnqueueId,
      });
    }

    // ANDROID
    const stack = await buildGoogleStack(app.credentialId);
    const listings = await stack.listings.fetchAll(app.bundleId);
    const arr = [...listings.values()];

    await tenantTransaction(async (tx) => {
      await tx.app.update({
        where: { id },
        data: {
          availableLanguages: arr.map((l) => l.language),
          lastFetchedAt: new Date(),
          dirty: false,
        },
      });
      for (const l of arr) {
        await tx.appLocalization.upsert({
          where: { appId_locale: { appId: id, locale: l.language } },
          create: {
            appId: id,
            tenantId: app.tenantId,
            locale: l.language,
            name: l.title,
            shortDescription: l.shortDescription,
            description: l.fullDescription,
            videoUrl: l.video,
            dirty: false,
            lastFetchedAt: new Date(),
          },
          update: {
            name: l.title,
            shortDescription: l.shortDescription,
            description: l.fullDescription,
            videoUrl: l.video,
            dirty: false,
            lastFetchedAt: new Date(),
          },
        });
      }
    });

    // Google Play has no iOS-style "keywords" field — nothing to import.
    await recordAudit({
      action: "metadata.fetch",
      target: `app:${id}`,
      appId: id,
      outcome: "SUCCESS",
      diff: { locales: arr.length },
    });
    return NextResponse.json({ ok: true, locales: arr.length });
  });
});

// Silence unused import error for ValidationError import (kept for future)
void ValidationError;

/**
 * First-time onboarding hook — enqueue an initial Astro autopilot job
 * for this app if (a) we just imported brand-new "default" keywords
 * AND (b) no previous astro analyze has ever been recorded for this
 * app. Returns the new Job id when fired, otherwise null.
 *
 * The intent: when a user adds a new app, they shouldn't have to
 * click "Run Astro Autopilot" manually — the default keywords should
 * already be mined + scored by the time the user lands on the ASO
 * dashboard. Subsequent metadata fetches reuse the manual button
 * (we don't want every keyword edit to silently burn Astro quota).
 */
async function maybeEnqueueInitialAstro(params: {
  tenantId: string;
  userId: string;
  appId: string;
  importedThisRun: number;
}): Promise<string | null> {
  if (params.importedThisRun === 0) return null;
  const prior = await prisma.job.findFirst({
    where: { appId: params.appId, kind: "aso.astro.analyze" },
    select: { id: true },
  });
  if (prior) return null;
  try {
    const { jobId } = await enqueue(
      "aso.astro.analyze",
      {
        tenantId: params.tenantId,
        userId: params.userId,
        appId: params.appId,
        // Conservative defaults for the first run: no competitor
        // mining (cheap), skip empty territories. The user can
        // re-run with richer options later from the UI.
        includeCompetitorMining: false,
        skipEmptyTerritories: true,
      },
      { appId: params.appId },
    );
    return jobId;
  } catch {
    // Astro not configured or queue not reachable — fail open. The
    // user can still manually trigger autopilot from the UI.
    return null;
  }
}
