/**
 * GET /api/v1/apps/[id]/aso/astro/latest
 *
 * Returns the merged Astro autopilot view for this app.
 *
 * Why "merged" instead of "the most recent job's result"?
 *   Per-locale analyze lets the user re-run a SINGLE locale without
 *   re-spending Astro/AI budget on every other one. If we returned only
 *   the most recent job's result, a single-locale re-run would wipe
 *   every other locale's proposals from the UI. Instead, we union the
 *   last N completed jobs per-locale — each locale shows its FRESHEST
 *   analyze result, with `analyzedAt` markers so the user can spot
 *   stale entries.
 *
 * Response shape:
 *   {
 *     job: null                          // never run yet
 *   }
 *   OR
 *   {
 *     job: {                             // job for status-banner UI
 *       id, status, createdAt, startedAt, finishedAt,
 *       progress: { current, total, step },
 *       error?: { code, message },
 *       targetLocales: string[] | null   // null = whole-app run
 *     },
 *     merged: AstroAnalyzeResponse | null,  // unioned per-locale view
 *     perLocaleAnalyzedAt: Record<string, string>  // locale → ISO
 *   }
 *
 * The `job` field always tracks the freshest job (in-flight if one
 * exists, else the most recent completed/failed). `merged` only changes
 * when a NEW analyze completes — refreshes give the user the same view.
 */
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@marquee/db";
import type { Prisma } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";
import {
  mergeAstroSnapshots,
  type AnalyzeJobResult,
  type RecommendationBucket,
  type SyncBucket,
} from "@/lib/mergeAstroSnapshots";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const dynamic = "force-dynamic";

/** How many recent completed jobs to consider when merging per-locale
 *  snapshots. 20 covers ~3 weeks of daily runs; older snapshots fall
 *  out of view (the user should re-analyze them anyway). */
const MERGE_HISTORY_LIMIT = 20;

/** Uniform response shape so `withApiErrors` can infer a single
 *  TReturn for the handler. Null fields cover the "never analyzed"
 *  state. */
interface LatestResponse {
  job: {
    id: string;
    status: string;
    createdAt: string;
    startedAt: string | null;
    finishedAt: string | null;
    progress: { current: number; total: number; step: string | null };
    result: null;
    error: unknown;
    targetLocales: string[] | null;
  } | null;
  merged: {
    astroAppId: string | null;
    endpoint: string;
    syncByTerritory: SyncBucket[];
    recommendationsByLocale: RecommendationBucket[];
    totals: {
      added: number;
      skipped: number;
      proposals: number;
      autoSwaps: number;
      opportunities: number;
    };
    durationMs: number;
  } | null;
  perLocaleAnalyzedAt: Record<string, string>;
  perLocaleJobId: Record<string, string>;
}

export const GET = withApiErrors(async (_req: NextRequest, context: RouteContext) => {
  const ctx = await requireTenant();
  const { id } = await context.params;

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({
      where: { id },
      select: { id: true },
    });
    if (!app) throw new NotFoundError("App not found");

    // ── Job currently used for the status banner ──────────────────────
    // Prefer an in-flight QUEUED/RUNNING (so the UI can pick it up),
    // else fall back to the most-recent completed/failed so we still
    // know the last attempt's outcome.
    const inflight = await prisma.job.findFirst({
      where: {
        appId: id,
        kind: "aso.astro.analyze",
        status: { in: ["QUEUED", "RUNNING"] },
        tenantId: ctx.tenant!.id,
      },
      orderBy: { createdAt: "desc" },
    });
    const fallback =
      inflight ??
      (await prisma.job.findFirst({
        where: {
          appId: id,
          kind: "aso.astro.analyze",
          tenantId: ctx.tenant!.id,
        },
        orderBy: { createdAt: "desc" },
      }));

    if (!fallback) {
      // Uniform response shape — null fields rather than a different
      // object — so the `withApiErrors` wrapper can infer a single
      // return type for the handler. The UI tolerates `job === null`.
      const empty: LatestResponse = {
        job: null,
        merged: null,
        perLocaleAnalyzedAt: {},
        perLocaleJobId: {},
      };
      return NextResponse.json<LatestResponse>(empty);
    }

    // ── Per-locale merge across last N completed jobs ─────────────────
    // Query newest-first so `mergeAstroSnapshots` can keep the freshest
    // result per locale. Older runs that touched the same locale get
    // masked.
    const completedJobs = await prisma.job.findMany({
      where: {
        appId: id,
        kind: "aso.astro.analyze",
        status: "COMPLETED",
        tenantId: ctx.tenant!.id,
      },
      orderBy: { finishedAt: "desc" },
      take: MERGE_HISTORY_LIMIT,
      select: {
        id: true,
        finishedAt: true,
        result: true,
      },
    });

    const { merged, perLocaleAnalyzedAt, perLocaleJobId } = mergeAstroSnapshots(
      completedJobs.map((j) => ({
        id: j.id,
        finishedAt: j.finishedAt?.toISOString() ?? null,
        result: (j.result ?? null) as AnalyzeJobResult | null,
      })),
    );

    const jobPayload = fallback.payload as Prisma.JsonObject | null;
    const targetLocales = extractTargetLocales(jobPayload);

    const response: LatestResponse = {
      job: {
        id: fallback.id,
        status: fallback.status,
        createdAt: fallback.createdAt.toISOString(),
        startedAt: fallback.startedAt?.toISOString() ?? null,
        finishedAt: fallback.finishedAt?.toISOString() ?? null,
        progress: {
          current: fallback.progressCurrent,
          total: fallback.progressTotal,
          step: fallback.progressStep,
        },
        result: null, // intentionally omitted — UI must use `merged`
        error: fallback.status === "FAILED" ? fallback.error : null,
        targetLocales,
      },
      merged,
      perLocaleAnalyzedAt,
      perLocaleJobId,
    };
    return NextResponse.json<LatestResponse>(response);
  });
});

function extractTargetLocales(payload: Prisma.JsonObject | null): string[] | null {
  if (!payload || typeof payload !== "object") return null;
  const raw = (payload as Record<string, unknown>).locales;
  if (!Array.isArray(raw)) return null;
  const out: string[] = [];
  for (const v of raw) {
    if (typeof v === "string" && v.length > 0) out.push(v);
  }
  return out.length > 0 ? out : null;
}
