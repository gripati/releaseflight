/**
 * Keywords shell — header + sub-tab nav + sticky locale rail.
 *
 * Replaces the inline locale dropdown filter with a left-rail picker
 * (Studio / Screenshots pattern). The selected locale lives in the URL
 * as `?locale=en-US`, so:
 *   • Tab switches between Opportunities / Tracked / History /
 *     Competitors preserve the locale scope.
 *   • Page reloads + deep links land on the same view.
 *   • Server components can read `searchParams.locale` directly.
 *
 * Layout is two-column on lg+ and stacks on mobile. The rail occupies
 * 220 px on the left; the canvas takes the remaining width.
 */
import { notFound } from "next/navigation";
import { tenantStorage, prisma } from "@marquee/db";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { KeywordsSubNav } from "@/components/shell/KeywordsSubNav";
import {
  KeywordsLocaleRail,
  type LocaleEntry,
} from "@/components/aso/KeywordsLocaleRail";

interface LayoutProps {
  children: React.ReactNode;
  params: Promise<{ tenantSlug: string; appId: string }>;
}

export const dynamic = "force-dynamic";

export default async function KeywordsLayout({
  children,
  params,
}: LayoutProps): Promise<JSX.Element> {
  const { tenantSlug, appId } = await params;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();

  // Locale entries: union of every locale present in AppLocalization
  // (so locales without keywords still show up — operator can run
  // Astro for them) PLUS every territory that has tracked keywords.
  const data = await tenantStorage.run(
    {
      tenantId: tenant.id,
      userId: session.user.id,
      role: tenant.role,
      requestId: crypto.randomUUID(),
    },
    async () => {
      const [app, localizations] = await Promise.all([
        prisma.app.findUnique({
          where: { id: appId },
          select: { primaryLocale: true, platform: true },
        }),
        prisma.appLocalization.findMany({
          where: { appId },
          select: { locale: true, dirty: true },
          orderBy: { locale: "asc" },
        }),
      ]);
      if (!app) return null;
      return { app, localizations };
    },
  );
  if (!data) notFound();

  // Rail entries only need locale + dirty for the Pending-Push state
  // dot and filter. Opportunity / tracked counters were removed —
  // they lived on the chip badge before, but the user-facing rail
  // now matches the Metadata picker exactly (flag + name only) and
  // those counts are surfaced inside the Opportunities + Tracked
  // sub-tabs themselves where they're more discoverable.
  const entries: LocaleEntry[] = data.localizations.map((l) => ({
    locale: l.locale,
    dirty: l.dirty,
  }));

  return (
    <div className="space-y-3">
      {/* Page-title strap was retired — the sub-nav doubles as the
       *  page identifier (active tab tells you where you are), and
       *  primary actions (Sync all, Run Astro, …) portal into the
       *  sub-nav's right-edge slot so the surface doesn't need a
       *  separate header just to host them. */}
      <KeywordsSubNav tenantSlug={tenantSlug} appId={appId} />

      <KeywordsLocaleRail entries={entries} primaryLocale={data.app.primaryLocale} />
      <section className="min-w-0">{children}</section>
    </div>
  );
}
