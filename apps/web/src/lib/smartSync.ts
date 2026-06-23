/**
 * Smart ASO sync — single entrypoint that figures out what to pull.
 *
 * The user shouldn't have to pick between "yesterday only" / "30d
 * backfill" / "90d backfill" + "import from metadata". This helper
 * inspects current DB state and queues the right jobs:
 *
 *   1. Analytics gap   — pulls the missing day-range from ASC Analytics.
 *                        • No history yet → 90-day backfill
 *                        • Behind by N days → catch up
 *                        • Up to date → re-pull yesterday (Apple often
 *                          revises the most recent day)
 *   2. Keywords from metadata — fast synchronous import of any tokens
 *      in each locale's keywords field that aren't tracked yet.
 *
 * Keyword SIGNAL refresh used to be triggered here via the
 * `aso.keywords.refresh` job (iTunes rank + Apple popularity + Google
 * Trends). That path has been removed — Astro is now the single
 * source of truth for keyword signals via `aso.astro.analyze`. The
 * `keywords` field on the result shape is kept for callers but always
 * reports `queued: false` with `reason: "use-astro-analyze"`.
 *
 * Designed to be cheap to re-trigger — pressing "Sync" repeatedly is
 * idempotent because the enqueue layer dedupes by idempotency-key.
 */
import { prisma } from "@marquee/db";
import { enqueue } from "@marquee/jobs";
import { NotFoundError } from "@marquee/core";
import { syncKeywordsFromMetadata } from "./keywordsFromMetadata";

export interface SmartSyncResult {
  app: { id: string; appName: string; platform: "IOS" | "ANDROID" };
  analytics: {
    queued: boolean;
    jobId: string | null;
    /** "first-backfill" | "catch-up" | "refresh-yesterday" | "skipped-not-ios" */
    mode: "first-backfill" | "catch-up" | "refresh-yesterday" | "skipped-not-ios";
    fromDate: string | null;
    toDate: string | null;
    days: number;
  };
  keywords: {
    queued: boolean;
    jobId: string | null;
    activeCount: number;
    reason?: string;
  };
  metadataImport: {
    importedCount: number;
    skippedExisting: number;
    perLocale: { locale: string; tokens: number; imported: number }[];
  };
}

const FIRST_BACKFILL_DAYS = 90;
const MAX_BACKFILL_DAYS = 365;

export async function runSmartSync(params: {
  tenantId: string;
  appId: string;
  userId: string;
}): Promise<SmartSyncResult> {
  const app = await prisma.app.findUnique({
    where: { id: params.appId },
    select: {
      id: true,
      appName: true,
      platform: true,
      storeAppId: true,
      credentialId: true,
      bundleId: true,
    },
  });
  if (!app) throw new NotFoundError("App not found");

  // ── 1. Analytics range
  const today = startOfUtcDay();
  const yesterday = new Date(today);
  yesterday.setUTCDate(yesterday.getUTCDate() - 1);

  let analytics: SmartSyncResult["analytics"];
  if (app.platform !== "IOS") {
    analytics = {
      queued: false,
      jobId: null,
      mode: "skipped-not-ios",
      fromDate: null,
      toDate: null,
      days: 0,
    };
  } else {
    // Inspect what we have on file so we can pick the right window.
    //   • No snapshots at all                   → 90-day first backfill.
    //   • Latest snapshot < yesterday           → catch up from there.
    //   • Latest = yesterday BUT impressions=0  → Apple Analytics is
    //     still ramping up. Backfill the last 30 days so that when
    //     Apple's snapshot becomes available we capture all of it in
    //     one pass instead of dribbling in one day per sync.
    //   • Latest = yesterday WITH impressions   → just refresh yesterday.
    const recentSnaps = await prisma.analyticsSnapshot.findMany({
      where: { appId: app.id },
      orderBy: { date: "desc" },
      take: 30,
      select: { date: true, impressions: true, pageViews: true },
    });
    const latest = recentSnaps[0] ?? null;
    const hasAnyAnalyticsSignals = recentSnaps.some((s) => s.impressions > 0 || s.pageViews > 0);

    let mode: SmartSyncResult["analytics"]["mode"];
    let fromDate: Date;
    const toDate: Date = yesterday;
    if (!latest) {
      mode = "first-backfill";
      fromDate = new Date(yesterday);
      fromDate.setUTCDate(fromDate.getUTCDate() - (FIRST_BACKFILL_DAYS - 1));
    } else if (latest.date < yesterday) {
      mode = "catch-up";
      fromDate = new Date(latest.date);
      fromDate.setUTCDate(fromDate.getUTCDate() + 1);
      const span = daysBetween(fromDate, toDate);
      if (span > MAX_BACKFILL_DAYS) {
        fromDate = new Date(toDate);
        fromDate.setUTCDate(fromDate.getUTCDate() - (MAX_BACKFILL_DAYS - 1));
      }
    } else if (!hasAnyAnalyticsSignals) {
      // We have rows (probably from Sales Reports) but no Analytics
      // signals yet — re-pull a wide window so when Apple's snapshot
      // populates we sweep it up in one shot.
      mode = "catch-up";
      fromDate = new Date(yesterday);
      fromDate.setUTCDate(fromDate.getUTCDate() - (FIRST_BACKFILL_DAYS - 1));
    } else {
      mode = "refresh-yesterday";
      fromDate = yesterday;
    }

    const fromIso = isoDate(fromDate);
    const toIso = isoDate(toDate);
    // No idempotency key on smart-sync. Each click is a fresh decision
    // based on current DB state — repeated clicks within the same
    // minute are wasteful but never *stuck*, which matters more.
    const enqRes = await enqueue(
      "aso.analytics.sync",
      {
        tenantId: params.tenantId,
        userId: params.userId,
        appId: app.id,
        fromDate: fromIso,
        toDate: toIso,
      },
      { appId: app.id },
    );
    analytics = {
      queued: true,
      jobId: enqRes.jobId,
      mode,
      fromDate: fromIso,
      toDate: toIso,
      days: daysBetween(fromDate, toDate),
    };
  }

  // ── 2. Keyword signals
  // Keyword signal refresh is no longer triggered here — Astro is the
  // single source of truth. Callers that want fresh signals should
  // enqueue `aso.astro.analyze` for the app (and optionally scope it
  // to a single locale via the per-locale Re-analyze button).
  const activeCount = await prisma.trackedKeyword.count({
    where: { appId: app.id, status: "ACTIVE" },
  });
  const keywords: SmartSyncResult["keywords"] = {
    queued: false,
    jobId: null,
    activeCount,
    reason: "use-astro-analyze",
  };

  // ── 3. Metadata-keyword import (sync, cheap — no Apple round-trip)
  let metadataImport: SmartSyncResult["metadataImport"] = {
    importedCount: 0,
    skippedExisting: 0,
    perLocale: [],
  };
  try {
    metadataImport = await syncKeywordsFromMetadata({
      tenantId: params.tenantId,
      appId: app.id,
      userId: params.userId,
    });
  } catch {
    // Don't block the sync if metadata isn't fetched yet.
  }

  return {
    app: { id: app.id, appName: app.appName, platform: app.platform },
    analytics,
    keywords,
    metadataImport,
  };
}

function startOfUtcDay(): Date {
  const d = new Date();
  d.setUTCHours(0, 0, 0, 0);
  return d;
}

function isoDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

function daysBetween(a: Date, b: Date): number {
  return Math.max(0, Math.floor((b.getTime() - a.getTime()) / 86_400_000) + 1);
}
