/**
 * Shared ASO dashboard projection.
 *
 * Extracted from the GET /api/v1/apps/[id]/aso/dashboard route so server
 * components (Pulse) can call it IN-PROCESS instead of doing an HTTP
 * self-fetch — the loopback re-ran the entire auth chain and added a
 * round-trip (and, in dev, a second route compile). The route is now a thin
 * wrapper around this; the Overview client still hits the route for its
 * range-switch refetches.
 *
 * Assumes it runs INSIDE a `tenantStorage.run` scope (uses the RLS-scoped
 * `prisma` client) — callers must establish tenant context first.
 */
import { prisma } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import type { Decimal } from "@prisma/client/runtime/library";
import { parseKeywordsField } from "@/lib/keywordsFromMetadata";
import type { DashboardData } from "@/components/aso/Overview";

const RANGE_TO_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90, "1y": 365 };

/** Clamp an arbitrary range token to a supported window (defaults 30d). */
export function normaliseRange(rangeQ: string | null | undefined): string {
  const r = rangeQ ?? "30d";
  return r in RANGE_TO_DAYS ? r : "30d";
}

/**
 * Single-call data source for the Overview/Pulse dashboard. Returns
 * everything the surface renders so the page makes ONE batch of queries and
 * the user sees one consistent point-in-time snapshot.
 */
export async function loadAsoDashboard(appId: string, rangeInput: string): Promise<DashboardData> {
  const range = normaliseRange(rangeInput);
  const days = RANGE_TO_DAYS[range]!;
  const id = appId;

  const app = await prisma.app.findUnique({
    where: { id },
    select: {
      id: true,
      appName: true,
      platform: true,
      primaryLocale: true,
      bundleId: true,
      availableLanguages: true,
      lastFetchedAt: true,
      lastPushedAt: true,
    },
  });
  if (!app) throw new NotFoundError("App not found");

  const today = new Date();
  today.setUTCHours(0, 0, 0, 0);
  const since = new Date(today);
  since.setUTCDate(since.getUTCDate() - days);
  const prevSince = new Date(today);
  prevSince.setUTCDate(prevSince.getUTCDate() - days * 2);

  const [
    thisWindow,
    prevWindow,
    funnels,
    keywordsRaw,
    snapshots,
    primaryLoc,
    allLocales,
    snapshotsAll,
  ] = await Promise.all([
    prisma.analyticsSnapshot.findMany({
      where: { appId: id, date: { gte: since, lte: today } },
      orderBy: { date: "asc" },
      select: {
        date: true,
        impressions: true,
        pageViews: true,
        downloads: true,
        firstTimeDownloads: true,
        pvcrPct: true,
      },
    }),
    prisma.analyticsSnapshot.findMany({
      where: { appId: id, date: { gte: prevSince, lt: since } },
      orderBy: { date: "asc" },
      select: {
        impressions: true,
        pageViews: true,
        downloads: true,
      },
    }),
    prisma.analyticsFunnel.findMany({
      where: { appId: id, date: { gte: since, lte: today } },
      select: { territory: true, downloads: true, pageViews: true },
    }),
    prisma.trackedKeyword.findMany({
      where: { appId: id, status: "ACTIVE" },
      orderBy: { keyword: "asc" },
      take: 60,
      include: {
        signals: { orderBy: { date: "desc" }, take: 1 },
      },
    }),
    prisma.metadataSnapshot.findMany({
      where: { appId: id, pushedAt: { gte: since } },
      orderBy: { pushedAt: "desc" },
      take: 8,
    }),
    prisma.appLocalization.findUnique({
      where: { appId_locale: { appId: id, locale: app.primaryLocale } },
    }),
    prisma.appLocalization.findMany({
      where: { appId: id },
      select: { locale: true, keywords: true, name: true, subtitle: true },
    }),
    prisma.metadataSnapshot.findMany({
      where: { appId: id },
      orderBy: { pushedAt: "asc" },
      take: 200,
    }),
  ]);

  // Totals + delta
  const totals = sumWindow(thisWindow);
  const prevTotals = sumWindow(prevWindow);
  const delta = {
    impressions: pctDelta(totals.impressions, prevTotals.impressions),
    pageViews: pctDelta(totals.pageViews, prevTotals.pageViews),
    downloads: pctDelta(totals.downloads, prevTotals.downloads),
    pvcrPctPoints:
      prevTotals.pageViews > 0
        ? totals.pvcrPct - (prevTotals.downloads / prevTotals.pageViews) * 100
        : null,
  };

  // Per-territory rollup
  const byTerritory = new Map<string, { units: number; pageViews: number }>();
  for (const f of funnels) {
    const cur = byTerritory.get(f.territory) ?? { units: 0, pageViews: 0 };
    cur.units += f.downloads;
    cur.pageViews += f.pageViews;
    byTerritory.set(f.territory, cur);
  }
  const territories = Array.from(byTerritory.entries())
    .filter(([t]) => t !== "ALL")
    .map(([territory, v]) => ({ territory, units: v.units, pageViews: v.pageViews }))
    .sort((a, b) => b.units - a.units)
    .slice(0, 10);

  // Devices — not derivable from the current Engagement Standard parse.
  // Returned empty for now; the UI shows a tasteful placeholder.
  const devices: { device: string; share: number }[] = [];

  // Current keywords field for the primary locale → which tracked keywords
  // are live RIGHT NOW.
  const primaryTokens = new Set(
    parseKeywordsField(primaryLoc?.keywords ?? null).map((t) => t.toLowerCase()),
  );

  // Per-locale token sets, so we can show "live in en-US, tr-TR" badges
  // beside each tracked keyword.
  const tokensByLocale = new Map<string, Set<string>>();
  for (const l of allLocales) {
    tokensByLocale.set(
      l.locale,
      new Set(parseKeywordsField(l.keywords).map((t) => t.toLowerCase())),
    );
  }

  // Score-sort: champions first, then by latest score desc.
  const keywords = keywordsRaw
    .map((k) => {
      const latest = k.signals[0];
      const liveLocales: string[] = [];
      for (const [loc, toks] of tokensByLocale) {
        if (toks.has(k.keyword.toLowerCase())) liveLocales.push(loc);
      }
      return {
        id: k.id,
        keyword: k.keyword,
        territory: k.territory,
        source: k.source,
        bucket: latest?.bucket ?? null,
        score: latest?.score !== null && latest?.score !== undefined ? Number(latest.score) : null,
        rank: latest?.appStoreRank ?? null,
        difficulty: latest?.difficulty ?? null,
        maxReachChance: latest?.maxReachChance ?? null,
        liveLocales,
      };
    })
    .sort((a, b) => (b.score ?? -1) - (a.score ?? -1));
  const keywordsLiveInPrimary = keywords.filter((k) =>
    primaryTokens.has(k.keyword.toLowerCase()),
  ).length;

  // Compute correlated download deltas for recent push events.
  const dlSince = new Date(since);
  dlSince.setUTCDate(dlSince.getUTCDate() - 7);
  const downloadsForDelta = await prisma.analyticsSnapshot.findMany({
    where: { appId: id, date: { gte: dlSince } },
    orderBy: { date: "asc" },
    select: { date: true, downloads: true },
  });

  // Build the "diff vs. previous in same locale" for each recent snapshot.
  const byLocaleSnapshots = new Map<string, typeof snapshotsAll>();
  for (const s of snapshotsAll) {
    const arr = byLocaleSnapshots.get(s.locale) ?? [];
    arr.push(s);
    byLocaleSnapshots.set(s.locale, arr);
  }

  const recentMoves = snapshots.map((s) => {
    const localeSeries = byLocaleSnapshots.get(s.locale) ?? [];
    const idx = localeSeries.findIndex((x) => x.id === s.id);
    const prev = idx > 0 ? localeSeries[idx - 1] : undefined;
    const before = sumWindowDownloads(downloadsForDelta, s.pushedAt, -7, 0);
    const after = sumWindowDownloads(downloadsForDelta, s.pushedAt, 0, 7);
    const downloadDelta = after - before;
    const downloadDeltaPct = before > 0 ? (downloadDelta / before) * 100 : null;
    const summary = summariseDiff(prev, s);
    return {
      id: s.id,
      locale: s.locale,
      pushedAt: s.pushedAt.toISOString(),
      downloadsBefore: before,
      downloadsAfter: after,
      downloadDelta,
      downloadDeltaPct,
      addedTokens: summary.addedTokens,
      removedTokens: summary.removedTokens,
      changedFields: summary.changedFields,
    };
  });

  // Active locales = locales with non-empty metadata (any of name/subtitle/keywords filled)
  const activeLocales = allLocales.filter((l) => (l.name?.trim() ?? "").length > 0).length;

  return {
    range,
    windowDays: days,
    app: {
      id: app.id,
      appName: app.appName,
      platform: app.platform,
      primaryLocale: app.primaryLocale,
      bundleId: app.bundleId,
      activeLocales,
      lastFetchedAt: app.lastFetchedAt?.toISOString() ?? null,
      lastPushedAt: app.lastPushedAt?.toISOString() ?? null,
    },
    totals,
    delta,
    downloadsDaily: thisWindow.map((s) => ({
      date: s.date.toISOString().slice(0, 10),
      downloads: s.downloads,
      pageViews: s.pageViews,
      impressions: s.impressions,
      pvcrPct: Number(s.pvcrPct),
    })),
    territories,
    devices,
    keywords: {
      items: keywords.slice(0, 12),
      totalTracked: keywords.length,
      liveInPrimary: keywordsLiveInPrimary,
      primaryLocale: app.primaryLocale,
    },
    currentMetadata: primaryLoc
      ? {
          locale: primaryLoc.locale,
          name: primaryLoc.name,
          subtitle: primaryLoc.subtitle,
          keywordsField: primaryLoc.keywords,
          promotionalText: primaryLoc.promotionalText,
          description: primaryLoc.description,
          lastPushedAt: primaryLoc.lastPushedAt?.toISOString() ?? null,
          dirty: primaryLoc.dirty,
          keywordsFieldChars: (primaryLoc.keywords ?? "").length,
          keywordsFieldTokens: parseKeywordsField(primaryLoc.keywords).length,
        }
      : null,
    recentMoves,
  };
}

// ──────────────────────────────────────────────────────────────────

interface DailyTotalsRow {
  impressions: number;
  pageViews: number;
  downloads: number;
  firstTimeDownloads?: number;
  pvcrPct?: Decimal;
}

function sumWindow(rows: DailyTotalsRow[]): {
  impressions: number;
  pageViews: number;
  downloads: number;
  firstTimeDownloads: number;
  pvcrPct: number;
} {
  let imp = 0;
  let pv = 0;
  let dl = 0;
  let ftd = 0;
  for (const r of rows) {
    imp += r.impressions;
    pv += r.pageViews;
    dl += r.downloads;
    if (typeof r.firstTimeDownloads === "number") ftd += r.firstTimeDownloads;
  }
  return {
    impressions: imp,
    pageViews: pv,
    downloads: dl,
    firstTimeDownloads: ftd,
    pvcrPct: pv > 0 ? (dl / pv) * 100 : 0,
  };
}

function pctDelta(curr: number, prev: number): number | null {
  if (prev <= 0) return null;
  return ((curr - prev) / prev) * 100;
}

function sumWindowDownloads(
  series: { date: Date; downloads: number }[],
  origin: Date,
  fromDays: number,
  toDays: number,
): number {
  const a = new Date(origin);
  a.setUTCDate(a.getUTCDate() + fromDays);
  const b = new Date(origin);
  b.setUTCDate(b.getUTCDate() + toDays);
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  let total = 0;
  for (const s of series) {
    if (s.date >= lo && s.date <= hi) total += s.downloads;
  }
  return total;
}

function summariseDiff(
  prev:
    | {
        name: string | null;
        subtitle: string | null;
        keywordsField: string | null;
        description: string | null;
        promotionalText: string | null;
        shortDescription: string | null;
      }
    | undefined,
  curr: {
    name: string | null;
    subtitle: string | null;
    keywordsField: string | null;
    description: string | null;
    promotionalText: string | null;
    shortDescription: string | null;
  },
): { addedTokens: string[]; removedTokens: string[]; changedFields: string[] } {
  const changedFields: string[] = [];
  const TRACKED = [
    "name",
    "subtitle",
    "keywordsField",
    "promotionalText",
    "description",
    "shortDescription",
  ] as const;
  const allAdded = new Set<string>();
  const allRemoved = new Set<string>();
  for (const field of TRACKED) {
    const before = prev?.[field] ?? null;
    const after = curr[field] ?? null;
    if ((before ?? "") === (after ?? "")) continue;
    changedFields.push(field);
    const bef = tokenise(before);
    const aft = tokenise(after);
    for (const t of aft) if (!bef.has(t)) allAdded.add(t);
    for (const t of bef) if (!aft.has(t)) allRemoved.add(t);
  }
  return {
    addedTokens: Array.from(allAdded).slice(0, 8),
    removedTokens: Array.from(allRemoved).slice(0, 8),
    changedFields,
  };
}

function tokenise(text: string | null): Set<string> {
  if (!text) return new Set();
  return new Set(
    text
      .toLowerCase()
      .split(/[\s,/.]+/)
      .map((t) => t.replace(/[^\w]/g, ""))
      .filter((t) => t.length >= 3),
  );
}
