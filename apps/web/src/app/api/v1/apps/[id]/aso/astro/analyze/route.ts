/**
 * POST /api/v1/apps/[id]/aso/astro/analyze
 *
 * Enqueues an `aso.astro.analyze` background job. The autopilot:
 *
 *   1. Registers the app in Astro (`add_app`).
 *   2. Pushes every tracked keyword per storefront (`add_keywords`,
 *      chunked ≤100, rate-limited).
 *   3. Mines stronger candidates (`get_keyword_suggestions` per
 *      storefront, optionally `extract_competitors_keywords`).
 *   4. Fuses the candidates with Apple Search Ads + Trends + local
 *      rank data into DECAY_AUTO / OPPORTUNITY_PREVIEW proposals.
 *
 * Returns `{ jobId }` immediately. The UI polls `GET /jobs/[id]` for
 * progress + final result. The result is persisted on `Job.result`
 * JSONB so it survives page refreshes until the next re-run.
 *
 * Idempotency: one running job per app at a time — re-clicking
 * "Re-run" while a previous job is RUNNING returns the existing
 * jobId so the UI keeps polling instead of stacking duplicate work.
 *
 * Body:
 *   {
 *     locales?: string[],
 *     includeCompetitorMining?: boolean (default false),
 *     skipEmptyTerritories?: boolean   (default true),
 *     maxProposalsPerLocale?: 1..30    (default 12),
 *     maxAutoSwapsPerLocale?: 0..15    (default 6),
 *     minStrengthDelta?: 0..1          (default 0.10),
 *   }
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@marquee/db";
import { enqueue } from "@marquee/jobs";
import { NotFoundError, ValidationError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { assertAiRateLimit } from "@/lib/rateLimitWrap";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const Body = z.object({
  locales: z.array(z.string().min(2).max(20)).max(60).optional(),
  maxProposalsPerLocale: z.number().int().min(1).max(30).default(12),
  maxAutoSwapsPerLocale: z.number().int().min(0).max(15).default(6),
  minStrengthDelta: z.number().min(0).max(1).default(0.1),
  // Astro's `get_keyword_suggestions` is sparse; competitor mining is
  // the real recommendation engine. Default ON — the client's rate
  // limiter handles the extra call volume.
  includeCompetitorMining: z.boolean().default(true),
  skipEmptyTerritories: z.boolean().default(true),
  /** Enrich top candidates with REAL Apple popularity + difficulty via
   *  `add_keywords` (one call per locale). Without this the filters
   *  below have no Apple data to work with — fall back to dropping
   *  only obvious noise. Default true. */
  enrichWithMetrics: z.boolean().default(true),
  /** Realistic-target popularity floor (Apple's 0-100 index). Default
   *  25 — drops dead-tail terms most apps shouldn't waste a slot on. */
  minPopularity: z.number().int().min(0).max(100).default(25),
  /** Realistic-target difficulty ceiling. Default 60 — keeps winnable
   *  pockets for low-authority apps. Raise to 80 for established apps
   *  that can compete on big keywords. */
  maxDifficulty: z.number().int().min(0).max(100).default(60),
});

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id } = await context.params;
  await assertAiRateLimit(`${ctx.tenantContext.tenantId}:${id}:astro-analyze`);
  const body = Body.parse(await req.json().catch(() => ({})));

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({
      where: { id },
      select: { id: true, platform: true },
    });
    if (!app) throw new NotFoundError("App not found");
    if (app.platform !== "IOS") {
      throw new ValidationError(
        "Astro autopilot only supports iOS apps — Google Play uses a different keyword model.",
      );
    }

    // De-dupe live work — only ONE analyze can run per app at a time
    // (Astro's 30 req/min rate limit is per-worker, so parallel runs
    // would step on each other). If a job is in flight we return its
    // id + targetLocales so the UI can either pick up the existing one
    // (when the user's request is already covered) or surface a clear
    // "wait for X to finish" message when the locales don't match.
    const existing = await prisma.job.findFirst({
      where: {
        appId: id,
        kind: "aso.astro.analyze",
        status: { in: ["QUEUED", "RUNNING"] },
      },
      orderBy: { createdAt: "desc" },
    });
    if (existing) {
      const existingPayload = existing.payload as Record<string, unknown> | null;
      const existingLocalesRaw = existingPayload?.locales;
      const existingLocales: string[] | null = Array.isArray(existingLocalesRaw)
        ? existingLocalesRaw.filter((v): v is string => typeof v === "string")
        : null;
      return NextResponse.json(
        {
          jobId: existing.id,
          status: existing.status,
          reused: true,
          existingTargetLocales: existingLocales, // null = whole-app run
          requestedLocales: body.locales ?? null,
        },
        { status: 200 },
      );
    }

    const { jobId } = await enqueue(
      "aso.astro.analyze",
      {
        tenantId: ctx.tenant!.id,
        userId: ctx.user.id,
        appId: id,
        ...(body.locales && { locales: body.locales }),
        includeCompetitorMining: body.includeCompetitorMining,
        skipEmptyTerritories: body.skipEmptyTerritories,
        maxProposalsPerLocale: body.maxProposalsPerLocale,
        maxAutoSwapsPerLocale: body.maxAutoSwapsPerLocale,
        minStrengthDelta: body.minStrengthDelta,
        enrichWithMetrics: body.enrichWithMetrics,
        minPopularity: body.minPopularity,
        maxDifficulty: body.maxDifficulty,
      },
      // No idempotency-key per-day cap here — the user can re-run as
      // often as they like. The QUEUED/RUNNING dedup above handles
      // back-to-back clicks.
      { appId: id },
    );

    return NextResponse.json({ jobId, status: "QUEUED", reused: false }, { status: 202 });
  });
});
