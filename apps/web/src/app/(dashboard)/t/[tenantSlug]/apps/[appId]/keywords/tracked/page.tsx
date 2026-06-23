/**
 * Keywords / Tracked — every active TrackedKeyword for this app.
 *
 * Compact table view with filters: locale, tag (default / adopted /
 * competitor), bucket (CHAMPION / NEUTRAL / DECAY). Phase 3 replaces
 * this with a unified row list shared with /opportunities, plus a
 * detail drawer per keyword.
 */
import { notFound } from "next/navigation";
import { tenantStorage, prisma } from "@marquee/db";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { Card, Stamp } from "@marquee/ui";
import { territoryFlag } from "@marquee/core/locale";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
  searchParams: Promise<{ locale?: string }>;
}

export const dynamic = "force-dynamic";

export default async function TrackedKeywordsPage({
  params,
  searchParams,
}: PageProps): Promise<JSX.Element> {
  const { tenantSlug, appId } = await params;
  const sp = await searchParams;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();

  // Locale scope from the sidebar rail. Translate locale → territory
  // (storefront) for the TrackedKeyword filter — e.g. `fr-FR` → `FR`.
  const { localeRegion } = await import("@marquee/core");
  const territoryFilter =
    sp.locale && sp.locale !== "ALL" ? localeRegion(sp.locale) : null;

  const rows = await tenantStorage.run(
    {
      tenantId: tenant.id,
      userId: session.user.id,
      role: tenant.role,
      requestId: crypto.randomUUID(),
    },
    async () => {
      const kws = await prisma.trackedKeyword.findMany({
        where: {
          appId,
          status: "ACTIVE",
          ...(territoryFilter ? { territory: territoryFilter } : {}),
        },
        orderBy: [{ territory: "asc" }, { keyword: "asc" }],
        take: 1000,
        include: {
          signals: {
            orderBy: { date: "desc" },
            take: 1,
            select: { score: true, bucket: true, appStoreRank: true },
          },
        },
      });
      return kws;
    },
  );

  return (
    <div className="space-y-4">
      <p className="font-mono text-[11px] text-[var(--ink-tertiary)]">
        {rows.length.toString()} active keyword{rows.length === 1 ? "" : "s"}
      </p>

      {rows.length === 0 ? (
        <Card className="border-dashed">
          <p className="font-body text-[13px] text-[var(--ink-secondary)]">
            No tracked keywords yet. Pull metadata from the store so the auto-importer
            seeds defaults from each locale&apos;s keywords field, or adopt suggestions
            from the <a href={`/t/${tenantSlug}/apps/${appId}/keywords`} className="text-[var(--signal)] underline-offset-2 hover:underline">Opportunities</a> panel above.
          </p>
        </Card>
      ) : (
        <div className="overflow-hidden rounded-[var(--radius-sm)] border-[0.5px] border-[var(--stroke-default)]">
          <div className="grid grid-cols-[28px_1fr_80px_80px_90px_120px] gap-3 border-b-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-tinted)] px-3 py-2 font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
            <span />
            <span>Keyword</span>
            <span className="text-right">Rank</span>
            <span className="text-right">Score</span>
            <span className="text-center">Bucket</span>
            <span>Tags</span>
          </div>
          {rows.map((k) => {
            const sig = k.signals[0];
            return (
              <div
                key={k.id}
                className="grid grid-cols-[28px_1fr_80px_80px_90px_120px] items-center gap-3 border-t-[0.5px] border-[var(--stroke-default)] px-3 py-2 text-[12px]"
              >
                <span aria-hidden className="text-[14px]">
                  {territoryFlag(k.territory)}
                </span>
                <div className="min-w-0">
                  <span className="block truncate font-medium text-[var(--ink-primary)]">
                    {k.keyword}
                  </span>
                  <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">
                    {k.territory}
                  </span>
                </div>
                <span className="text-right font-mono tabular-nums text-[var(--ink-secondary)]">
                  {sig?.appStoreRank ?? "—"}
                </span>
                <span className="text-right font-mono tabular-nums text-[var(--ink-secondary)]">
                  {sig?.score != null ? Number(sig.score).toFixed(2) : "—"}
                </span>
                <span className="text-center">
                  {sig?.bucket ? (
                    <Stamp
                      variant={
                        sig.bucket === "CHAMPION"
                          ? "success"
                          : sig.bucket === "DECAY"
                            ? "danger"
                            : "default"
                      }
                    >
                      {sig.bucket}
                    </Stamp>
                  ) : (
                    <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">—</span>
                  )}
                </span>
                <span className="flex flex-wrap gap-1">
                  {k.tags.length === 0 ? (
                    <span className="font-mono text-[10px] text-[var(--ink-tertiary)]">—</span>
                  ) : (
                    k.tags.map((t) => (
                      <span
                        key={t}
                        className="rounded-full bg-[var(--surface-sunken)] px-1.5 py-0.5 font-mono text-[9px] uppercase tracking-[0.06em] text-[var(--ink-secondary)]"
                      >
                        {t}
                      </span>
                    ))
                  )}
                </span>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
}
