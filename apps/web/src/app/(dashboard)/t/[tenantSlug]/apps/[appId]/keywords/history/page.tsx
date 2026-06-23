/**
 * Keywords / History — metadata edit timeline + keyword swap log
 * for this app. Rehoused from /aso/history under the new IA.
 */
import { notFound } from "next/navigation";
import { tenantStorage, prisma } from "@marquee/db";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import {
  MetadataHistoryView,
  type DailySeries,
  type MetadataDiffEntry,
  type MetadataHistoryEvent,
} from "@/components/aso/MetadataHistory";
import { SwapHistorySection } from "@/components/aso/SwapHistorySection";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
  searchParams: Promise<{ range?: string }>;
}

const RANGE_TO_DAYS: Record<string, number> = {
  "30d": 30,
  "90d": 90,
  "180d": 180,
  "365d": 365,
};
const TRACKED_FIELDS = [
  "name",
  "subtitle",
  "keywordsField",
  "promotionalText",
  "description",
  "shortDescription",
] as const;

export const dynamic = "force-dynamic";

export default async function KeywordsHistoryPage({
  params,
  searchParams,
}: PageProps): Promise<JSX.Element> {
  const { tenantSlug, appId } = await params;
  const sp = await searchParams;
  const rangeParam = sp.range && sp.range in RANGE_TO_DAYS ? sp.range : "90d";
  const days = RANGE_TO_DAYS[rangeParam]!;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();

  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - days);
  const dlSince = new Date(since);
  dlSince.setUTCDate(dlSince.getUTCDate() - 7);
  const dlUntil = new Date();
  dlUntil.setUTCDate(dlUntil.getUTCDate() + 1);

  const data = await tenantStorage.run(
    {
      tenantId: tenant.id,
      userId: session.user.id,
      role: tenant.role,
      requestId: crypto.randomUUID(),
    },
    async () => {
      const app = await prisma.app.findUnique({
        where: { id: appId },
        select: { id: true },
      });
      if (!app) return null;
      const [snapshotsAll, downloads] = await Promise.all([
        prisma.metadataSnapshot.findMany({
          where: { appId },
          orderBy: { pushedAt: "asc" },
          take: 500,
        }),
        prisma.analyticsSnapshot.findMany({
          where: { appId, date: { gte: dlSince, lte: dlUntil } },
          orderBy: { date: "asc" },
          select: { date: true, downloads: true, pageViews: true, pvcrPct: true },
        }),
      ]);
      return { snapshotsAll, downloads };
    },
  );
  if (!data) notFound();

  const inWindow = data.snapshotsAll.filter((s) => s.pushedAt >= since);
  const byLocale = new Map<string, typeof data.snapshotsAll>();
  for (const s of data.snapshotsAll) {
    const arr = byLocale.get(s.locale) ?? [];
    arr.push(s);
    byLocale.set(s.locale, arr);
  }

  const events: MetadataHistoryEvent[] = inWindow.map((s) => {
    const localeSeries = byLocale.get(s.locale) ?? [];
    const idx = localeSeries.findIndex((x) => x.id === s.id);
    const prev = idx > 0 ? localeSeries[idx - 1] : undefined;
    const diff = computeDiff(prev, s);
    const before = sumWindow(data.downloads, s.pushedAt, -7, 0);
    const after = sumWindow(data.downloads, s.pushedAt, 0, 7);
    const downloadDelta = after.downloads - before.downloads;
    const downloadDeltaPct = before.downloads > 0 ? (downloadDelta / before.downloads) * 100 : null;
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
  events.reverse();

  const downloadsSeries: DailySeries[] = data.downloads
    .filter((d) => d.date >= since)
    .map((d) => ({
      date: d.date.toISOString().slice(0, 10),
      downloads: d.downloads,
      pvcrPct: Number(d.pvcrPct),
    }));

  return (
    <div className="space-y-8">
      <MetadataHistoryView
        tenantSlug={tenantSlug}
        appId={appId}
        range={rangeParam}
        windowDays={days}
        events={events}
        downloads={downloadsSeries}
      />
      <SwapHistorySection appId={appId} />
    </div>
  );
}

function computeDiff(
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
): MetadataDiffEntry[] {
  const out: MetadataDiffEntry[] = [];
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
