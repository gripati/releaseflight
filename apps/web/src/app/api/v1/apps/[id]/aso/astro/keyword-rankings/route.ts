/**
 * GET /api/v1/apps/[id]/aso/astro/keyword-rankings?keyword=puzzle&store=us
 *
 * Wraps Astro's `search_rankings` tool with `includeHistory: true` to
 * surface:
 *   • currentRank — our app's live position for this keyword + store
 *     (Astro returns 1000 to mean "off the top-1000"; UI renders that
 *     as "off chart" with a soft tone).
 *   • previousRank — the snapshot just before the latest one. Used
 *     for an inline Δ chip ("↑ 3 since yesterday").
 *   • history[] — full timeline (date + ranking) for the position
 *     sparkline in KeywordDetailPopover.
 *   • popularity / difficulty — Astro's per-keyword metrics, 0-100.
 *
 * Rate-limit budget: 1 Astro call per request. The Astro client's
 * token-bucket limiter (25/min) protects the autopilot job from
 * starving when users open many popovers in a session.
 *
 * Returns 503 (via AstroNotConfiguredError) when no ASO_RESEARCH_MCP
 * credential exists so the popover can render a clean empty state.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@marquee/db";
import { NotFoundError, ValidationError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";
import { loadAstroAutopilot } from "@/lib/astroAutopilot";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const Query = z.object({
  keyword: z.string().trim().min(1).max(120),
  store: z.string().trim().length(2),
});

export const dynamic = "force-dynamic";

export const GET = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  const ctx = await requireTenant();
  const { id } = await context.params;
  const url = new URL(req.url);
  const parsed = Query.safeParse({
    keyword: url.searchParams.get("keyword") ?? "",
    store: url.searchParams.get("store") ?? "",
  });
  if (!parsed.success) {
    throw new ValidationError(
      `Invalid query: ${parsed.error.issues.map((i) => i.message).join(", ")}`,
    );
  }
  const { keyword, store } = parsed.data;

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!app) throw new NotFoundError("App not found");

    const loaded = await loadAstroAutopilot(ctx.tenant!.id);
    const sample = await loaded.autopilot.getKeywordRankings({
      keyword,
      store: store.toLowerCase(),
      includeHistory: true,
    });

    if (!sample) {
      return NextResponse.json({
        keyword,
        store: store.toLowerCase(),
        endpoint: loaded.endpoint,
        currentRank: null as number | null,
        previousRank: null as number | null,
        popularity: null as number | null,
        difficulty: null as number | null,
        history: [] as { date: string; rank: number }[],
        capturedAt: null as string | null,
        notTracked: true,
      });
    }

    // Sort history oldest → newest for the sparkline. Astro returns
    // newest-first; we flip so the chart reads left → right time-wise.
    const sortedHistory = sample.history
      .filter((h): h is { date: string; ranking: number } => h.ranking !== null)
      .map((h) => ({ date: h.date, rank: h.ranking }))
      .sort((a, b) => a.date.localeCompare(b.date));

    return NextResponse.json({
      keyword,
      store: store.toLowerCase(),
      endpoint: loaded.endpoint,
      currentRank: sample.rank,
      previousRank: sample.previousRank,
      popularity: sample.popularity,
      difficulty: sample.difficulty,
      history: sortedHistory,
      capturedAt: sample.capturedAt,
      notTracked: false,
    });
  });
});
