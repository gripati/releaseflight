/**
 * Keywords / Opportunities — current store field + Astro proposals.
 *
 * Layout:
 *   1. (Selected locale only) Current keywords field editor — shows the
 *      app's actual ASC keywords text for the locale, lets the operator
 *      edit it inline, save locally, and push to App Store Connect.
 *   2. Astro opportunities surface — the unified row list across every
 *      locale (or the selected one when ?locale=… is set).
 *
 * The tenant-wide stat strip (tracked / adopted / auto-imported /
 * competitors) used to sit between #1 and #2, but the Keywords surface
 * is for *editing the field*, not surveying the portfolio. Those
 * counters lived inside each sub-tab already (Tracked, Competitors)
 * where they belong, so the strip was duplicate signal blocking the
 * page from focusing on its actual job.
 *
 * The locale rail at the layout level drives which locale's field
 * editor renders. When `?locale=ALL` (default) we skip the editor
 * because there's no single locale to edit; the opportunities list
 * still works across every locale.
 */
import { notFound } from "next/navigation";
import { tenantStorage, prisma } from "@marquee/db";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { KeywordsOpportunitiesSurface } from "@/components/aso/KeywordsOpportunitiesSurface";
import { KeywordsFieldEditor } from "@/components/aso/KeywordsFieldEditor";
import { localeRegion } from "@marquee/core";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
  searchParams: Promise<{ locale?: string }>;
}

export const dynamic = "force-dynamic";

export default async function OpportunitiesPage({
  params,
  searchParams,
}: PageProps): Promise<JSX.Element> {
  const { tenantSlug, appId } = await params;
  const sp = await searchParams;
  const selectedLocale =
    sp.locale && sp.locale !== "ALL" ? sp.locale : null;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();

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
        select: { id: true, appName: true, platform: true },
      });
      if (!app) return null;

      // Per-locale data — only when a specific locale is selected.
      let localeData: {
        appLocalization: {
          locale: string;
          name: string | null;
          subtitle: string | null;
          keywords: string | null;
          dirty: boolean;
        };
        trackedKeywords: {
          id: string;
          keyword: string;
          score: number | null;
          bucket: string | null;
          rank: number | null;
        }[];
      } | null = null;

      if (selectedLocale) {
        const territory = localeRegion(selectedLocale);
        const [loc, tracked] = await Promise.all([
          prisma.appLocalization.findFirst({
            where: { appId, locale: selectedLocale },
            select: {
              locale: true,
              name: true,
              subtitle: true,
              keywords: true,
              dirty: true,
            },
          }),
          prisma.trackedKeyword.findMany({
            where: { appId, status: "ACTIVE", territory },
            include: {
              signals: {
                orderBy: { date: "desc" },
                take: 1,
                select: { score: true, bucket: true, appStoreRank: true },
              },
            },
          }),
        ]);
        if (loc) {
          localeData = {
            appLocalization: loc,
            trackedKeywords: tracked.map((k) => {
              const sig = k.signals[0];
              return {
                id: k.id,
                keyword: k.keyword,
                score: sig?.score != null ? Number(sig.score) : null,
                bucket: sig?.bucket ?? null,
                rank: sig?.appStoreRank ?? null,
              };
            }),
          };
        }
      }

      return { app, localeData };
    },
  );
  if (!data) notFound();

  return (
    <div className="space-y-6">
      {/* ── Per-locale keywords field editor (only when scoped) ── */}
      {data.localeData ? (
        <KeywordsFieldEditor
          appId={data.app.id}
          appName={data.app.appName}
          platform={data.app.platform}
          locale={data.localeData.appLocalization.locale}
          title={data.localeData.appLocalization.name}
          subtitle={data.localeData.appLocalization.subtitle}
          initialValue={data.localeData.appLocalization.keywords}
          initialDirty={data.localeData.appLocalization.dirty}
          trackedKeywords={data.localeData.trackedKeywords}
        />
      ) : (
        <AllLocalesHint />
      )}

      {/* ── Astro opportunities ──────────────────────────────────── */}
      <KeywordsOpportunitiesSurface appId={appId} />
    </div>
  );
}

function AllLocalesHint(): JSX.Element {
  return (
    <div className="rounded-[var(--radius-lg)] border border-dashed border-[var(--stroke-default)] bg-[var(--surface-elevated)] p-5">
      <p className="text-[13px] text-[var(--ink-secondary)]">
        Pick a locale on the left rail to view + edit its <strong>keywords
        field</strong> and push the change to App Store Connect. Astro
        opportunities below span every locale until a scope is chosen.
      </p>
    </div>
  );
}
