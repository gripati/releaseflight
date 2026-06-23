/**
 * POST /api/v1/apps/[id]/metadata/[locale]/ai-generate
 *
 * Per-field AI generation. The caller picks ONE field (title /
 * subtitle / keywords / promo / description) for ONE locale. The
 * model returns:
 *   • a scored assessment of the CURRENT copy
 *   • 2-5 ranked alternatives with strength + verdict + plain reasoning
 *
 * Designed for fast iteration — every field is its own request, so
 * the editor can light up generate buttons in parallel.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@marquee/db";
import { buildFieldVariantsTask, fieldKindAllowed, type FieldVariantsInput } from "@marquee/aso";
import { NotFoundError, ValidationError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { loadAiOrchestrator } from "@/lib/aiOrchestrator";
import { localeMeta } from "@/lib/localeMeta";
import { deriveTerritory } from "@/lib/keywordsFromMetadata";
import { assertAiRateLimit } from "@/lib/rateLimitWrap";

interface RouteContext {
  params: Promise<{ id: string; locale: string }>;
}

const Body = z.object({
  field: z.enum(["title", "subtitle", "keywords", "promo", "description"]),
  count: z.number().int().min(2).max(5).optional(),
});

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id, locale } = await context.params;
  await assertAiRateLimit(`${ctx.tenantContext.tenantId}:${id}:ai-generate`);
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

    if (!fieldKindAllowed(body.field, app.platform)) {
      throw new ValidationError(
        `Field "${body.field}" is not available on ${app.platform}. Choose title, description or platform-appropriate fields.`,
      );
    }

    const territory = deriveTerritory(locale);
    const [localization, tracked, snapshots, prevSnapshots] = await Promise.all([
      prisma.appLocalization.findUnique({
        where: { appId_locale: { appId: id, locale } },
      }),
      prisma.trackedKeyword.findMany({
        where: { appId: id, status: "ACTIVE", territory },
        include: { signals: { orderBy: { date: "desc" }, take: 1 } },
        take: 60,
      }),
      prisma.analyticsSnapshot.findMany({
        where: { appId: id, date: { gte: daysAgo(30) } },
        select: { downloads: true },
      }),
      prisma.analyticsSnapshot.findMany({
        where: { appId: id, date: { gte: daysAgo(60), lt: daysAgo(30) } },
        select: { downloads: true },
      }),
    ]);

    if (!localization) {
      throw new ValidationError(
        `No localization yet for ${locale} — open the metadata workbench to populate the fields first.`,
      );
    }

    const downloads30d = snapshots.reduce((s, r) => s + r.downloads, 0);
    const prev30d = prevSnapshots.reduce((s, r) => s + r.downloads, 0);
    const downloadsTrendPct = prev30d > 0 ? ((downloads30d - prev30d) / prev30d) * 100 : null;

    const input: FieldVariantsInput = {
      field: body.field,
      appName: app.appName,
      bundleId: app.bundleId,
      platform: app.platform,
      locale,
      languageName: localeMeta(locale).name,
      primaryGenre: null,
      context: {
        title: localization.name,
        subtitle: localization.subtitle,
        keywords: localization.keywords,
        promo: localization.promotionalText,
        description: localization.description,
      },
      downloads30d,
      downloadsTrendPct,
      trackedKeywords: tracked
        .map((k) => {
          const sig = k.signals[0];
          return {
            keyword: k.keyword,
            score: sig?.score != null ? Number(sig.score) : null,
            rank: sig?.appStoreRank ?? null,
            bucket: sig?.bucket ?? null,
            volume: sig?.volume ?? null,
            maxVolume: sig?.maxVolume ?? null,
            difficulty: sig?.difficulty ?? null,
            maxReachChance: sig?.maxReachChance ?? null,
          };
        })
        .sort((a, b) => (b.score ?? 0) - (a.score ?? 0)),
      count: body.count ?? 3,
    };

    const { orchestrator } = await loadAiOrchestrator(ctx.tenant!.id);
    const task = buildFieldVariantsTask(input);
    const result = await orchestrator.run(task);
    if (!result.ok) {
      throw new ValidationError(`AI generation failed (${result.code}): ${result.message}`, {
        code: "AI_FAILED",
        provider: result.provider,
        retriable: result.retriable,
      });
    }

    return NextResponse.json({
      field: body.field,
      locale,
      result: result.output,
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
