/**
 * Keyword detail — drilldown for one TrackedKeyword.
 *
 * Rehoused from /aso/keywords/[kwId] under the new IA. Surface unchanged
 * (KeywordDetail component); Phase 3 will swap this whole route for an
 * in-place drawer on the Keywords index instead of a full page.
 */
import { notFound } from "next/navigation";
import { tenantStorage, prisma } from "@marquee/db";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import {
  KeywordDetail,
  type KeywordDetailAlternative,
  type KeywordDetailData,
  type KeywordDetailDownload,
  type KeywordDetailPushAnnotation,
  type KeywordDetailSignal,
} from "@/components/aso/KeywordDetail";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string; kwId: string }>;
  searchParams: Promise<{ range?: string }>;
}

const RANGE_TO_DAYS: Record<string, number> = {
  "14d": 14,
  "30d": 30,
  "90d": 90,
  "180d": 180,
};

export const dynamic = "force-dynamic";

export default async function KeywordDetailPage({
  params,
  searchParams,
}: PageProps): Promise<JSX.Element> {
  const { tenantSlug, appId, kwId } = await params;
  const sp = await searchParams;
  const rangeParam = sp.range && sp.range in RANGE_TO_DAYS ? sp.range : "30d";
  const days = RANGE_TO_DAYS[rangeParam]!;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();

  const since = new Date();
  since.setUTCHours(0, 0, 0, 0);
  since.setUTCDate(since.getUTCDate() - days);

  const data = await tenantStorage.run(
    {
      tenantId: tenant.id,
      userId: session.user.id,
      role: tenant.role,
      requestId: crypto.randomUUID(),
    },
    async () => {
      const keyword = await prisma.trackedKeyword.findFirst({
        where: { id: kwId, appId },
      });
      if (!keyword) return null;

      const [signals, snapshots, neighbours, downloads] = await Promise.all([
        prisma.keywordSignal.findMany({
          where: { trackedKeywordId: kwId, date: { gte: since } },
          orderBy: { date: "asc" },
        }),
        prisma.metadataSnapshot.findMany({
          where: { appId, pushedAt: { gte: since } },
          orderBy: { pushedAt: "asc" },
          select: {
            id: true,
            locale: true,
            pushedAt: true,
            name: true,
            subtitle: true,
            keywordsField: true,
          },
        }),
        prisma.trackedKeyword.findMany({
          where: {
            appId,
            id: { not: kwId },
            territory: keyword.territory,
            status: "ACTIVE",
          },
          include: { signals: { orderBy: { date: "desc" }, take: 1 } },
        }),
        prisma.analyticsSnapshot.findMany({
          where: { appId, date: { gte: since } },
          orderBy: { date: "asc" },
          select: { date: true, downloads: true, pageViews: true, pvcrPct: true },
        }),
      ]);
      return { keyword, signals, snapshots, neighbours, downloads };
    },
  );
  if (!data) notFound();

  const { keyword, signals, snapshots, neighbours, downloads } = data;
  const pushesTouchingKeyword: KeywordDetailPushAnnotation[] = snapshots
    .filter((s) =>
      (s.keywordsField ?? "").toLowerCase().includes(keyword.keyword.toLowerCase()),
    )
    .map((s) => ({
      id: s.id,
      locale: s.locale,
      pushedAt: s.pushedAt.toISOString(),
      keywordsField: s.keywordsField,
      name: s.name,
      subtitle: s.subtitle,
    }));

  const tokens = tokenise(keyword.keyword);
  const alternatives: KeywordDetailAlternative[] = neighbours
    .map((n) => {
      const sig = n.signals[0];
      return {
        id: n.id,
        keyword: n.keyword,
        territory: n.territory,
        score: sig?.score !== null && sig?.score !== undefined ? Number(sig.score) : null,
        bucket: sig?.bucket ?? null,
        rank: sig?.appStoreRank ?? null,
        overlap: tokenOverlap(tokens, tokenise(n.keyword)),
      };
    })
    .filter((a) => a.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || (b.score ?? 0) - (a.score ?? 0))
    .slice(0, 8);

  const dto: KeywordDetailData = {
    keyword: {
      id: keyword.id,
      keyword: keyword.keyword,
      territory: keyword.territory,
      source: keyword.source,
      status: keyword.status,
      notes: keyword.notes,
      createdAt: keyword.createdAt.toISOString(),
    },
    range: rangeParam,
    windowDays: days,
    signals: signals.map<KeywordDetailSignal>((s) => ({
      date: s.date.toISOString().slice(0, 10),
      appStoreRank: s.appStoreRank,
      volume: s.volume,
      maxVolume: s.maxVolume,
      difficulty: s.difficulty,
      maxReachChance: s.maxReachChance,
      score: s.score !== null ? Number(s.score) : null,
      bucket: s.bucket,
    })),
    downloads: downloads.map<KeywordDetailDownload>((d) => ({
      date: d.date.toISOString().slice(0, 10),
      downloads: d.downloads,
      pageViews: d.pageViews,
      pvcrPct: Number(d.pvcrPct),
    })),
    pushAnnotations: pushesTouchingKeyword,
    alternatives,
  };

  return <KeywordDetail tenantSlug={tenantSlug} appId={appId} data={dto} />;
}

function tokenise(keyword: string): Set<string> {
  return new Set(
    keyword
      .toLowerCase()
      .split(/[\s,/]+/)
      .map((t) => t.replace(/[^\w]/g, ""))
      .filter((t) => t.length >= 3),
  );
}

function tokenOverlap(a: Set<string>, b: Set<string>): number {
  let n = 0;
  for (const t of a) if (b.has(t)) n += 1;
  return n;
}
