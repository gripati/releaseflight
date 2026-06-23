/**
 * Analytics — numerical drill-down surface.
 *
 * Phase 1 rehouses the existing `/aso/analytics` page here. Phase 4
 * will fold in the analytics fragments scattered across the old
 * Overview (territories breakdown, devices donut, custom date range)
 * into one focused workspace driven by a single data hook.
 */
import Link from "next/link";
import type { Route } from "next";
import { notFound } from "next/navigation";
import { tenantStorage, prisma } from "@marquee/db";
import { detectFunnelAnomalies, type FunnelDiagnostic } from "@marquee/aso";
import { Card, Stamp, Divider } from "@marquee/ui";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
  searchParams: Promise<{ range?: string; territory?: string }>;
}

const RANGE_TO_DAYS: Record<string, number> = { "7d": 7, "30d": 30, "90d": 90 };

export const dynamic = "force-dynamic";

export default async function AnalyticsPage({
  params,
  searchParams,
}: PageProps): Promise<JSX.Element> {
  const { tenantSlug, appId } = await params;
  const sp = await searchParams;
  const range = sp.range && sp.range in RANGE_TO_DAYS ? sp.range : "30d";
  const territory =
    sp.territory && /^([A-Z]{2}|ALL)$/.test(sp.territory) ? sp.territory : "ALL";

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
      const days = RANGE_TO_DAYS[range]!;
      const since = new Date();
      since.setUTCHours(0, 0, 0, 0);
      since.setUTCDate(since.getUTCDate() - days);

      const [snapshots, funnels] = await Promise.all([
        prisma.analyticsSnapshot.findMany({
          where: { appId, date: { gte: since } },
          orderBy: { date: "asc" },
        }),
        prisma.analyticsFunnel.findMany({
          where: { appId, date: { gte: since }, territory },
          orderBy: { date: "asc" },
        }),
      ]);
      return { snapshots, funnels };
    },
  );

  const anomalies: FunnelDiagnostic[] = detectFunnelAnomalies(
    data.snapshots.map((s) => ({
      date: s.date,
      impressions: s.impressions,
      pageViews: s.pageViews,
      downloads: s.downloads,
    })),
  );

  const bySource = data.funnels.reduce<
    Record<string, { impressions: number; pageViews: number; downloads: number }>
  >((acc, f) => {
    const cur = acc[f.source] ?? { impressions: 0, pageViews: 0, downloads: 0 };
    cur.impressions += f.impressions;
    cur.pageViews += f.pageViews;
    cur.downloads += f.downloads;
    acc[f.source] = cur;
    return acc;
  }, {});
  const sourceRows = Object.entries(bySource).sort(([, a], [, b]) => b.downloads - a.downloads);

  return (
    <div className="space-y-8">
      <header className="flex items-center justify-between gap-4 border-b-[0.5px] border-[var(--stroke-default)] pb-4">
        <div>
          <h1
            className="font-display text-2xl"
            style={{ fontVariationSettings: "'wght' 500" }}
          >
            Analytics
          </h1>
          <p className="mt-1 font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
            Range {range} · Territory {territory}
          </p>
        </div>
        <div className="flex gap-1">
          {(["7d", "30d", "90d"] as const).map((r) => (
            <Link
              key={r}
              href={
                `/t/${tenantSlug}/apps/${appId}/analytics?range=${r}&territory=${territory}` as Route
              }
              scroll={false}
              className={`rounded-[var(--radius-sm)] border-[0.5px] px-2.5 py-1 font-mono text-[11px] uppercase ${
                r === range
                  ? "border-[var(--ink-primary)] text-[var(--ink-primary)]"
                  : "border-[var(--stroke-default)] text-[var(--ink-secondary)] hover:text-[var(--ink-primary)]"
              }`}
            >
              {r}
            </Link>
          ))}
        </div>
      </header>

      {anomalies.length > 0 && (
        <section className="space-y-2">
          <h2 className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
            Anomalies
          </h2>
          {anomalies.map((a, i) => (
            <Card key={i} className="flex items-center gap-3">
              <Stamp
                variant={
                  a.severity === "HIGH"
                    ? "danger"
                    : a.severity === "MEDIUM"
                      ? "warning"
                      : "default"
                }
              >
                {a.severity}
              </Stamp>
              <span className="font-body text-[13px]">{a.message}</span>
            </Card>
          ))}
        </section>
      )}

      <section>
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
          Funnel by source
        </h2>
        {sourceRows.length === 0 ? (
          <Card className="border-dashed">
            <p className="font-body text-[13px] text-[var(--ink-secondary)]">
              No funnel rows for this window. Sync ASC Analytics to populate.
            </p>
          </Card>
        ) : (
          <Card>
            <div className="grid grid-cols-[140px_1fr_1fr_1fr_1fr] gap-3 border-b-[0.5px] border-[var(--stroke-default)] pb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
              <span>Source</span>
              <span className="text-right">Impressions</span>
              <span className="text-right">Page views</span>
              <span className="text-right">Downloads</span>
              <span className="text-right">PVCR</span>
            </div>
            {sourceRows.map(([source, totals]) => {
              const pvcr =
                totals.pageViews > 0 ? (totals.downloads / totals.pageViews) * 100 : 0;
              return (
                <div
                  key={source}
                  className="grid grid-cols-[140px_1fr_1fr_1fr_1fr] gap-3 border-t-[0.5px] border-[var(--stroke-default)] py-2.5 font-mono text-[12px] tabular-nums"
                >
                  <span className="uppercase tracking-[0.06em] text-[var(--ink-secondary)]">
                    {source}
                  </span>
                  <span className="text-right">{totals.impressions.toLocaleString()}</span>
                  <span className="text-right">{totals.pageViews.toLocaleString()}</span>
                  <span className="text-right">{totals.downloads.toLocaleString()}</span>
                  <span className="text-right">{pvcr.toFixed(2)}%</span>
                </div>
              );
            })}
          </Card>
        )}
      </section>

      <Divider />

      <section>
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
          Daily roll-up
        </h2>
        {data.snapshots.length === 0 ? (
          <Card className="border-dashed">
            <p className="font-body text-[13px] text-[var(--ink-secondary)]">
              No snapshots yet.
            </p>
          </Card>
        ) : (
          <Card>
            <div className="grid grid-cols-[110px_1fr_1fr_1fr_1fr] gap-3 border-b-[0.5px] border-[var(--stroke-default)] pb-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
              <span>Date</span>
              <span className="text-right">Impressions</span>
              <span className="text-right">Page views</span>
              <span className="text-right">Downloads</span>
              <span className="text-right">PVCR</span>
            </div>
            {data.snapshots
              .slice(-30)
              .reverse()
              .map((s) => (
                <div
                  key={s.id}
                  className="grid grid-cols-[110px_1fr_1fr_1fr_1fr] gap-3 border-t-[0.5px] border-[var(--stroke-default)] py-2 font-mono text-[12px] tabular-nums"
                >
                  <span className="text-[var(--ink-secondary)]">
                    {s.date.toISOString().slice(0, 10)}
                  </span>
                  <span className="text-right">{s.impressions.toLocaleString()}</span>
                  <span className="text-right">{s.pageViews.toLocaleString()}</span>
                  <span className="text-right">{s.downloads.toLocaleString()}</span>
                  <span className="text-right">{Number(s.pvcrPct).toFixed(2)}%</span>
                </div>
              ))}
          </Card>
        )}
      </section>
    </div>
  );
}
