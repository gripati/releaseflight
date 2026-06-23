/**
 * GET /api/v1/apps/[id]/aso/metadata-history?range=90d
 *
 * The "history book" — every metadata push event in the window, with
 * the diff vs. the previous snapshot (same locale) and a download
 * delta showing what happened in the 7 days AFTER the push, vs. the
 * 7 days BEFORE. This is the data layer for the keyword stock-market
 * "Recent moves" panel.
 *
 * The diff strictly compares the four iOS ASO surfaces — name,
 * subtitle, keywordsField, promotionalText — and for Android, name +
 * shortDescription + description. We don't surface noise (timestamp-only
 * changes etc.).
 */
import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const RANGE_TO_DAYS: Record<string, number> = { "30d": 30, "90d": 90, "180d": 180, "365d": 365 };

const TRACKED_FIELDS = ["name", "subtitle", "keywordsField", "promotionalText", "description", "shortDescription"] as const;
type TrackedField = (typeof TRACKED_FIELDS)[number];

export const dynamic = "force-dynamic";

export const GET = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id } = await context.params;
  const url = new URL(req.url);
  const rangeQ = url.searchParams.get("range") ?? "90d";
  const range = rangeQ in RANGE_TO_DAYS ? rangeQ : "90d";
  const days = RANGE_TO_DAYS[range]!;

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id }, select: { id: true, platform: true } });
    if (!app) throw new NotFoundError("App not found");

    const since = new Date();
    since.setUTCHours(0, 0, 0, 0);
    since.setUTCDate(since.getUTCDate() - days);

    // Pull a bit more history (one snapshot before `since`) so we can
    // diff the earliest in-window push against its predecessor.
    const snapshotsAll = await prisma.metadataSnapshot.findMany({
      where: { appId: id },
      orderBy: { pushedAt: "asc" },
      take: 500,
    });

    const inWindow = snapshotsAll.filter((s) => s.pushedAt >= since);
    if (inWindow.length === 0) {
      return NextResponse.json({ range, windowDays: days, events: [] });
    }

    // Group snapshots by locale so we can diff each against its
    // immediate predecessor in that locale.
    const byLocale = new Map<string, typeof snapshotsAll>();
    for (const s of snapshotsAll) {
      const arr = byLocale.get(s.locale) ?? [];
      arr.push(s);
      byLocale.set(s.locale, arr);
    }

    // Pull all daily downloads in the window — we need ±7d around each
    // push event for the delta calc. Fetch a buffer of +7d before/after.
    const dlSince = new Date(since);
    dlSince.setUTCDate(dlSince.getUTCDate() - 7);
    const dlUntil = new Date();
    dlUntil.setUTCDate(dlUntil.getUTCDate() + 1);
    const downloads = await prisma.analyticsSnapshot.findMany({
      where: { appId: id, date: { gte: dlSince, lte: dlUntil } },
      orderBy: { date: "asc" },
      select: { date: true, downloads: true, pageViews: true, pvcrPct: true },
    });

    const events = inWindow.map((s) => {
      const localeSeries = byLocale.get(s.locale) ?? [];
      const idx = localeSeries.findIndex((x) => x.id === s.id);
      const prev = idx > 0 ? localeSeries[idx - 1] : undefined;
      const diff = computeDiff(prev, s);

      const before = sumWindow(downloads, s.pushedAt, -7, 0);
      const after = sumWindow(downloads, s.pushedAt, 0, 7);
      const downloadDelta = after.downloads - before.downloads;
      const downloadDeltaPct =
        before.downloads > 0 ? (downloadDelta / before.downloads) * 100 : null;
      const pvcrBefore = before.pageViews > 0 ? (before.downloads / before.pageViews) * 100 : 0;
      const pvcrAfter = after.pageViews > 0 ? (after.downloads / after.pageViews) * 100 : 0;

      return {
        id: s.id,
        pushedAt: s.pushedAt.toISOString(),
        locale: s.locale,
        snapshot: {
          name: s.name,
          subtitle: s.subtitle,
          keywordsField: s.keywordsField,
          promotionalText: s.promotionalText,
          shortDescription: s.shortDescription,
        },
        diff,
        downloadsBefore7d: before.downloads,
        downloadsAfter7d: after.downloads,
        downloadDelta,
        downloadDeltaPct,
        pvcrBefore,
        pvcrAfter,
      };
    });

    // Newest first for the UI
    events.reverse();
    return NextResponse.json({
      range,
      windowDays: days,
      events,
    });
  });
});

interface DiffEntry {
  field: TrackedField;
  before: string | null;
  after: string | null;
  /** Tokens added / removed when both sides exist. Useful for keyword field diffs. */
  addedTokens: string[];
  removedTokens: string[];
}

function computeDiff(
  prev: { name: string | null; subtitle: string | null; keywordsField: string | null; description: string | null; promotionalText: string | null; shortDescription: string | null } | undefined,
  curr: { name: string | null; subtitle: string | null; keywordsField: string | null; description: string | null; promotionalText: string | null; shortDescription: string | null },
): DiffEntry[] {
  const out: DiffEntry[] = [];
  for (const field of TRACKED_FIELDS) {
    const before = prev?.[field] ?? null;
    const after = curr[field] ?? null;
    if ((before ?? "") === (after ?? "")) continue;
    const beforeTokens = tokenise(before);
    const afterTokens = tokenise(after);
    out.push({
      field,
      before,
      after,
      addedTokens: [...afterTokens].filter((t) => !beforeTokens.has(t)),
      removedTokens: [...beforeTokens].filter((t) => !afterTokens.has(t)),
    });
  }
  return out;
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

function sumWindow(
  series: { date: Date; downloads: number; pageViews: number }[],
  origin: Date,
  fromDays: number,
  toDays: number,
): { downloads: number; pageViews: number } {
  const a = new Date(origin);
  a.setUTCDate(a.getUTCDate() + fromDays);
  const b = new Date(origin);
  b.setUTCDate(b.getUTCDate() + toDays);
  const lo = a < b ? a : b;
  const hi = a < b ? b : a;
  let dl = 0;
  let pv = 0;
  for (const s of series) {
    if (s.date < lo || s.date > hi) continue;
    dl += s.downloads;
    pv += s.pageViews;
  }
  return { downloads: dl, pageViews: pv };
}
