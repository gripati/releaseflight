/**
 * POST /api/v1/apps/[id]/aso/recommend
 *
 * Runs the comprehensive ASO recommendation pack via the tenant's
 * configured AI chain. Pulls all locale metadata + tracked keyword
 * performance + last 30 days of downloads as context.
 *
 * Returns the model's structured output along with the provider
 * actually used + token + USD cost so the UI can show transparency.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@marquee/db";
import { buildAsoRecommendTask, type AsoRecommendInput } from "@marquee/aso";
import { NotFoundError, ValidationError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { loadAiOrchestrator } from "@/lib/aiOrchestrator";
import { parseKeywordsField } from "@/lib/keywordsFromMetadata";
import { localeMeta } from "@/lib/localeMeta";
import { assertAiRateLimit } from "@/lib/rateLimitWrap";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const Body = z.object({
  /** Optional override — focus the AI on just these locales. */
  locales: z.array(z.string().min(2).max(20)).max(20).optional(),
});

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id } = await context.params;
  await assertAiRateLimit(`${ctx.tenantContext.tenantId}:${id}:recommend`);
  const body = Body.parse(await req.json().catch(() => ({})));

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({
      where: { id },
      select: {
        id: true,
        appName: true,
        platform: true,
        primaryLocale: true,
        bundleId: true,
      },
    });
    if (!app) throw new NotFoundError("App not found");

    const [localizations, tracked, snapshots, prevSnapshots] = await Promise.all([
      prisma.appLocalization.findMany({
        where: {
          appId: id,
          ...(body.locales ? { locale: { in: body.locales } } : {}),
        },
        orderBy: { locale: "asc" },
      }),
      prisma.trackedKeyword.findMany({
        where: { appId: id, status: "ACTIVE" },
        include: { signals: { orderBy: { date: "desc" }, take: 1 } },
        take: 80,
      }),
      prisma.analyticsSnapshot.findMany({
        where: {
          appId: id,
          date: { gte: daysAgo(30) },
        },
        select: { downloads: true },
      }),
      prisma.analyticsSnapshot.findMany({
        where: {
          appId: id,
          date: { gte: daysAgo(60), lt: daysAgo(30) },
        },
        select: { downloads: true },
      }),
    ]);

    if (localizations.length === 0) {
      throw new ValidationError(
        "No localizations available — fetch metadata from the Metadata tab first.",
      );
    }

    const downloads30d = snapshots.reduce((s, r) => s + r.downloads, 0);
    const prev30d = prevSnapshots.reduce((s, r) => s + r.downloads, 0);
    const downloadsTrendPct = prev30d > 0 ? ((downloads30d - prev30d) / prev30d) * 100 : null;

    // Build keyword-in-field lookup so the AI knows which tracked
    // terms are already live in each locale's field.
    const localesByLocale = new Map<string, (typeof localizations)[number]>();
    for (const l of localizations) localesByLocale.set(l.locale, l);

    const input: AsoRecommendInput = {
      appName: app.appName,
      bundleId: app.bundleId,
      primaryLocale: app.primaryLocale,
      platform: app.platform,
      primaryGenre: null,
      locales: localizations.map((l) => ({
        locale: l.locale,
        languageName: localeMeta(l.locale).name,
        isPrimary: l.locale === app.primaryLocale,
        name: l.name,
        subtitle: l.subtitle,
        keywordsField: l.keywords,
        promotionalText: l.promotionalText,
        description: l.description,
      })),
      trackedKeywords: tracked.map((k) => {
        const sig = k.signals[0];
        // Find which locale's keywords field references this keyword
        // (any locale match — the AI only needs the boolean).
        let inField = false;
        for (const [, loc] of localesByLocale) {
          const tokens = parseKeywordsField(loc.keywords).map((t) => t.toLowerCase());
          if (tokens.includes(k.keyword.toLowerCase())) {
            inField = true;
            break;
          }
        }
        return {
          keyword: k.keyword,
          territory: k.territory,
          score: sig?.score != null ? Number(sig.score) : null,
          rank: sig?.appStoreRank ?? null,
          bucket: sig?.bucket ?? null,
          inField,
          volume: sig?.volume ?? null,
          maxVolume: sig?.maxVolume ?? null,
          difficulty: sig?.difficulty ?? null,
          maxReachChance: sig?.maxReachChance ?? null,
        };
      }),
      downloads30d,
      downloadsTrendPct,
    };

    const { orchestrator } = await loadAiOrchestrator(ctx.tenant!.id);
    const task = buildAsoRecommendTask(input);
    const result = await orchestrator.run(task);
    if (!result.ok) {
      throw new ValidationError(
        `AI recommendation failed (${result.code}): ${result.message}`,
        { code: "AI_FAILED", provider: result.provider, retriable: result.retriable },
      );
    }

    return NextResponse.json({
      pack: result.output,
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      usage: result.usage,
    });
  });
});

function daysAgo(n: number): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  d.setUTCDate(d.getUTCDate() - n);
  return d;
}
