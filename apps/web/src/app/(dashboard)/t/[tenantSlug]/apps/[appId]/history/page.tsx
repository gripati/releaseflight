import { notFound } from "next/navigation";
import { tenantStorage, prisma } from "@marquee/db";
import { Card, Stamp } from "@marquee/ui";
import { Clock } from "lucide-react";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";

interface PageProps {
  params: Promise<{ tenantSlug: string; appId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}

const PAGE_SIZE = 100;

function outcomeStamp(outcome: string): "success" | "danger" | "warning" {
  if (outcome === "SUCCESS") return "success";
  if (outcome === "FAILURE") return "danger";
  return "warning";
}

function relativeTime(d: Date): string {
  const ms = Date.now() - d.getTime();
  const sec = Math.round(ms / 1000);
  if (sec < 60) return `${sec.toString()}s ago`;
  if (sec < 3600) return `${Math.round(sec / 60).toString()}m ago`;
  if (sec < 86_400) return `${Math.round(sec / 3600).toString()}h ago`;
  return `${Math.round(sec / 86_400).toString()}d ago`;
}

export default async function AppHistoryPage({ params }: PageProps): Promise<JSX.Element> {
  const { tenantSlug, appId } = await params;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();

  const events = await tenantStorage.run(
    { tenantId: tenant.id, userId: session.user.id, role: tenant.role, requestId: crypto.randomUUID() },
    async () =>
      prisma.auditEvent.findMany({
        where: { appId },
        take: PAGE_SIZE,
        orderBy: { createdAt: "desc" },
        include: { user: { select: { displayName: true, email: true } } },
      }),
  );

  if (events.length === 0) {
    return (
      <div className="space-y-6">
        <HistoryHeader count={0} />
        <Card className="p-10 text-center">
          <Clock className="mx-auto h-10 w-10 text-[var(--ink-tertiary)]" aria-hidden />
          <h3 className="mt-4 font-display text-[18px] text-[var(--ink-primary)]">
            No activity yet for this app
          </h3>
          <p className="mt-2 font-body text-[13px] text-[var(--ink-secondary)]">
            When you push metadata, upload screenshots, or submit builds, the events appear here.
          </p>
        </Card>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      <HistoryHeader count={events.length} />
      <Card className="overflow-hidden p-0">
      <table className="w-full">
        <thead className="border-b-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-warm)]">
          <tr className="text-left font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
            <th className="px-4 py-3">Action</th>
            <th className="px-4 py-3">Outcome</th>
            <th className="px-4 py-3">Actor</th>
            <th className="px-4 py-3">Target</th>
            <th className="px-4 py-3 text-right">When</th>
          </tr>
        </thead>
        <tbody>
          {events.map((e) => (
            <tr key={e.id} className="border-b-[0.5px] border-[var(--stroke-default)] last:border-b-0">
              <td className="px-4 py-3 font-mono text-[12px] text-[var(--ink-primary)]">{e.action}</td>
              <td className="px-4 py-3">
                <Stamp variant={outcomeStamp(e.outcome)}>{e.outcome.toLowerCase()}</Stamp>
              </td>
              <td className="px-4 py-3 font-body text-[12px] text-[var(--ink-secondary)]">
                {e.user?.displayName ?? e.user?.email ?? "system"}
              </td>
              <td className="px-4 py-3 font-mono text-[11px] text-[var(--ink-tertiary)]">
                {e.target ? e.target.slice(0, 12) + "…" : "—"}
              </td>
              <td
                className="px-4 py-3 text-right font-mono text-[11px] text-[var(--ink-tertiary)]"
                title={e.createdAt.toISOString()}
              >
                {relativeTime(e.createdAt)}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      </Card>
    </div>
  );
}

function HistoryHeader({ count }: { count: number }): JSX.Element {
  return (
    <header className="flex flex-wrap items-end justify-between gap-3 border-b-[0.5px] border-[var(--stroke-default)] pb-4">
      <div>
        <p className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
          {count === 0 ? "No events" : `${count.toString()} recent event${count === 1 ? "" : "s"}`}
        </p>
        <h2
          className="mt-1 font-display text-2xl tracking-[-0.01em]"
          style={{ fontVariationSettings: "'wght' 500" }}
        >
          History
        </h2>
      </div>
    </header>
  );
}
