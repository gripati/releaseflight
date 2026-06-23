/**
 * Pulse — daily-health landing page.
 *
 * Loads today's daily-check (analyst brief + movers + alarms) AND the
 * existing dashboard projection (KPIs + deltas) so the surface can
 * render a focused "what changed today, what should I do" view
 * instead of the legacy kitchen-sink Overview.
 */
import { notFound } from "next/navigation";
import { tenantStorage, prisma } from "@marquee/db";
import {
  summariseRankMovers,
  topClimbers,
  topDecliners,
  type KeywordRankDelta,
} from "@marquee/aso";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { loadAsoDashboard } from "@/lib/asoDashboard";
import { PulseSurface, type PulseAlarm, type PulseData } from "@/components/aso/PulseSurface";
import type { RangeToken } from "@/components/aso/PulseDateFilter";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
  searchParams: Promise<{ range?: string; date?: string }>;
}

const RANGE_TO_DAYS: Record<RangeToken, number> = {
  "7d": 7,
  "30d": 30,
  "90d": 90,
  "1y": 365,
};

export const dynamic = "force-dynamic";

export default async function PulsePage({
  params,
  searchParams,
}: PageProps): Promise<JSX.Element> {
  const { tenantSlug, appId } = await params;
  const sp = await searchParams;
  const range: RangeToken =
    sp.range && sp.range in RANGE_TO_DAYS ? (sp.range as RangeToken) : "7d";
  const date =
    sp.date && /^\d{4}-\d{2}-\d{2}$/.test(sp.date)
      ? sp.date
      : new Date().toISOString().slice(0, 10);

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
    () => loadPulse({ appId, range, date }),
  );
  if (!data) notFound();

  return (
    <PulseSurface
      tenantSlug={tenantSlug}
      appId={appId}
      data={data}
      range={range}
      date={date}
    />
  );
}

async function loadPulse(opts: {
  appId: string;
  range: string;
  date: string;
}): Promise<PulseData | null> {
  // Dashboard projection is computed IN-PROCESS (no HTTP self-fetch) and the
  // daily-check + notifications run alongside it in one parallel batch — they
  // already share this page's tenantStorage scope.
  const [dashboard, check, notifications] = await Promise.all([
    loadAsoDashboard(opts.appId, opts.range),
    prisma.asoDailyCheck.findUnique({
      where: { appId_date: { appId: opts.appId, date: new Date(opts.date) } },
      select: {
        analystReport: true,
        keywordDeltas: true,
      },
    }),
    prisma.asoNotification.findMany({
      where: { appId: opts.appId, date: new Date(opts.date) },
      orderBy: [{ severity: "desc" }, { createdAt: "desc" }],
      take: 50,
      select: {
        id: true,
        severity: true,
        title: true,
        message: true,
        trackedKeywordId: true,
        createdAt: true,
      },
    }),
  ]);

  let daily: PulseData["daily"] = null;
  if (check) {
    const rawDeltas = ((check.keywordDeltas ?? []) as unknown) as KeywordRankDelta[];
    const moversSummary = summariseRankMovers(rawDeltas);
    // analystReport is stored as Prisma Json — pipe through `unknown`
    // so the projection lands on PulseData's typed shape without
    // pulling in the AnalystReport interface here.
    const report =
      check.analystReport != null
        ? (check.analystReport as unknown as PulseData["daily"] & {}) ?? null
        : null;
    daily = {
      date: opts.date,
      analystReport: report
        ? (report as unknown as NonNullable<PulseData["daily"]>["analystReport"])
        : null,
      movers: {
        climbers: topClimbers(moversSummary, 10),
        decliners: topDecliners(moversSummary, 10),
      },
      alarms: notifications.map<PulseAlarm>((n) => ({
        id: n.id,
        severity: n.severity as PulseAlarm["severity"],
        title: n.title,
        message: n.message,
        trackedKeywordId: n.trackedKeywordId,
        createdAt: n.createdAt.toISOString(),
      })),
    };
  } else if (notifications.length > 0) {
    // No check row yet but notifications exist — still render alarms.
    daily = {
      date: opts.date,
      analystReport: null,
      movers: { climbers: [], decliners: [] },
      alarms: notifications.map<PulseAlarm>((n) => ({
        id: n.id,
        severity: n.severity as PulseAlarm["severity"],
        title: n.title,
        message: n.message,
        trackedKeywordId: n.trackedKeywordId,
        createdAt: n.createdAt.toISOString(),
      })),
    };
  }

  return { dashboard, daily };
}
