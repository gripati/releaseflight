/**
 * Keywords / Competitors — paste-an-App-Store-URL → tracked competitor.
 *
 * Server-driven by the Keywords LocaleStrip above: when the operator
 * picks a territory chip the page re-renders with `?locale=…` in the
 * URL. We use that to pick which territory's snapshot lands on each
 * card — icon, screenshots, rating, version, description all become
 * the localized variant for that storefront. "All locales" (no param)
 * falls back to the operator's home territory.
 */
import { notFound } from "next/navigation";
import { tenantStorage, prisma } from "@marquee/db";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { localeRegion } from "@marquee/core/locale";
import {
  CompetitorsPanel,
  type CompetitorCard,
} from "@/components/aso/CompetitorsPanel";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
  searchParams: Promise<{ locale?: string }>;
}

export const dynamic = "force-dynamic";

export default async function CompetitorsPage({
  params,
  searchParams,
}: PageProps): Promise<JSX.Element> {
  const { tenantSlug, appId } = await params;
  const sp = await searchParams;
  const localeParam =
    sp.locale && sp.locale !== "ALL" ? sp.locale : null;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();
  void tenantSlug;

  const { rows, homeTerritory, appTerritories, selectedTerritory } =
    await tenantStorage.run(
      {
        tenantId: tenant.id,
        userId: session.user.id,
        role: tenant.role,
        requestId: crypto.randomUUID(),
      },
      () => loadCompetitorCards(appId, localeParam),
    );

  return (
    <CompetitorsPanel
      appId={appId}
      initialRows={rows}
      homeTerritory={homeTerritory}
      appTerritories={appTerritories}
      selectedTerritory={selectedTerritory}
    />
  );
}

async function loadCompetitorCards(
  appId: string,
  localeParam: string | null,
): Promise<{
  rows: CompetitorCard[];
  homeTerritory: string;
  appTerritories: string[];
  /** Territory the cards are showing, after resolving the URL param.
   *  Equal to `homeTerritory` when "All locales" is active. */
  selectedTerritory: string;
}> {
  const app = await prisma.app.findUnique({
    where: { id: appId },
    select: { primaryLocale: true },
  });
  const homeTerritory = app
    ? localeRegion(app.primaryLocale).toUpperCase()
    : "US";

  // Selected territory drives the per-card snapshot. When the operator
  // picks "All locales" or no scope, we fall back to the home market
  // — gives a stable default that always renders something useful.
  const selectedTerritory = localeParam
    ? localeRegion(localeParam).toUpperCase()
    : homeTerritory;

  // Every territory the operator's app serves — feeds the compare
  // modal's picker. Sets dedup multi-locale countries.
  const localizations = await prisma.appLocalization.findMany({
    where: { appId },
    select: { locale: true },
  });
  const territorySet = new Set<string>([homeTerritory]);
  for (const l of localizations) {
    territorySet.add(localeRegion(l.locale).toUpperCase());
  }
  const appTerritories = Array.from(territorySet).sort();

  const rows = await prisma.competitor.findMany({
    where: { appId },
    orderBy: [{ monitor: "desc" }, { bucket: "asc" }, { appName: "asc" }],
  });
  const ids = rows.map((c) => c.id);

  const [snaps, changes] = await Promise.all([
    ids.length
      ? prisma.competitorSnapshot.findMany({
          where: { competitorId: { in: ids }, territory: selectedTerritory },
          orderBy: [{ competitorId: "asc" }, { date: "desc" }],
        })
      : Promise.resolve([]),
    (() => {
      const sevenDaysAgo = new Date();
      sevenDaysAgo.setUTCDate(sevenDaysAgo.getUTCDate() - 7);
      return ids.length
        ? prisma.asoNotification.findMany({
            where: {
              appId,
              competitorId: { in: ids },
              date: { gte: sevenDaysAgo },
            },
            orderBy: { date: "desc" },
            select: {
              id: true,
              competitorId: true,
              date: true,
              severity: true,
              title: true,
              message: true,
              payload: true,
            },
          })
        : Promise.resolve([]);
    })(),
  ]);

  const snapByCompetitor = new Map<string, (typeof snaps)[number]>();
  for (const s of snaps) {
    if (!snapByCompetitor.has(s.competitorId)) {
      snapByCompetitor.set(s.competitorId, s);
    }
  }
  const changesByCompetitor = new Map<string, typeof changes>();
  for (const n of changes) {
    if (!n.competitorId) continue;
    const arr = changesByCompetitor.get(n.competitorId) ?? [];
    arr.push(n);
    changesByCompetitor.set(n.competitorId, arr);
  }

  const cards: CompetitorCard[] = rows.map((c) => {
    const snap = snapByCompetitor.get(c.id) ?? null;
    const cs = changesByCompetitor.get(c.id) ?? [];
    return {
      id: c.id,
      appName: c.appName,
      bundleId: c.bundleId,
      storeAppId: c.storeAppId,
      bucket: c.bucket,
      monitor: c.monitor,
      notes: c.notes,
      iconUrl: c.iconUrl,
      trackUrl: c.trackUrl,
      sellerName: c.sellerName,
      primaryGenre: c.primaryGenre,
      ingestCountry: c.ingestCountry,
      latestVersion: c.latestVersion,
      latestRating: c.latestRating,
      latestRatingCount: c.latestRatingCount,
      lastSyncedAt: c.lastSyncedAt?.toISOString() ?? null,
      snapshot: snap
        ? {
            territory: snap.territory,
            date: snap.date.toISOString().slice(0, 10),
            name: snap.name,
            subtitle: snap.subtitle,
            description: snap.description,
            version: snap.version,
            averageUserRating: snap.averageUserRating,
            userRatingCount: snap.userRatingCount,
            iconUrl: snap.iconUrl,
            iphoneScreenshotUrls: snap.iphoneScreenshotUrls,
            ipadScreenshotUrls: snap.ipadScreenshotUrls,
            primaryGenre: snap.primaryGenre,
            genres: snap.genres,
            price: snap.price,
            formattedPrice: snap.formattedPrice,
          }
        : null,
      recentChanges: cs.map((n) => ({
        id: n.id,
        date: n.date.toISOString().slice(0, 10),
        severity: n.severity as "info" | "warning" | "danger",
        title: n.title,
        message: n.message,
      })),
    };
  });

  return { rows: cards, homeTerritory, appTerritories, selectedTerritory };
}
