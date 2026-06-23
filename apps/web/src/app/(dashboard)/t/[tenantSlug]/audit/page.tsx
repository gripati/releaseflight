import { notFound } from "next/navigation";
import { tenantStorage, prisma } from "@marquee/db";
import { Card, Divider, Stamp } from "@marquee/ui";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { PageHeader } from "@/components/shell/PageHeader";

interface PageProps {
  params: Promise<{ tenantSlug: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}

const PAGE_SIZE = 80;

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

export default async function AuditPage({ params, searchParams }: PageProps): Promise<JSX.Element> {
  const { tenantSlug } = await params;
  const sp = await searchParams;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();

  const action = sp.action ?? null;
  const outcome = sp.outcome ?? null;

  const events = await tenantStorage.run(
    {
      tenantId: tenant.id,
      userId: session.user.id,
      role: tenant.role,
      requestId: crypto.randomUUID(),
      allowedAppIds: tenant.allowedAppIds,
    },
    async () =>
      prisma.auditEvent.findMany({
        where: {
          ...(action ? { action } : {}),
          ...(outcome ? { outcome: outcome as "SUCCESS" | "FAILURE" | "PARTIAL" } : {}),
          // AuditEvent is tenant-only at the RLS layer, so per-member app scoping
          // must be applied here: a scoped member sees app-bound events only for
          // their apps (+ tenant-level, null-app events). Empty = unrestricted.
          ...(tenant.allowedAppIds.length > 0
            ? { OR: [{ appId: null }, { appId: { in: tenant.allowedAppIds } }] }
            : {}),
        },
        take: PAGE_SIZE,
        orderBy: { createdAt: "desc" },
        include: {
          user: { select: { displayName: true, email: true } },
          app: { select: { appName: true, platform: true } },
        },
      }),
  );

  const actions = [
    { id: null, label: "All" },
    { id: "metadata.fetch", label: "metadata.fetch" },
    { id: "metadata.push", label: "metadata.push" },
    { id: "metadata.import-master-json", label: "import-master-json" },
    { id: "screenshot.upload", label: "screenshot.upload" },
    { id: "screenshot.bulk-import-zip", label: "screenshot.bulk-import" },
    { id: "screenshot.apply-to-locales", label: "apply-to-locales" },
    { id: "preview.upload", label: "preview.upload" },
    { id: "app.create", label: "app.create" },
    { id: "app.update", label: "app.update" },
    { id: "app.delete", label: "app.delete" },
  ];
  const outcomes = [null, "SUCCESS", "PARTIAL", "FAILURE"];

  return (
    <div className="page-loaded">
      <PageHeader
        title="Activity"
        eyebrow={`Last ${PAGE_SIZE.toString()} events`}
        description="Every mutating action in this workspace, with the diff payload, user and outcome."
      />

      <Card className="mb-6">
        <div className="flex flex-wrap items-center gap-3">
          <span className="font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
            Filter
          </span>
          <FilterGroup label="action" current={action} options={actions} tenantSlug={tenantSlug} extra={{ outcome }} />
          <Divider orientation="vertical" className="h-5" />
          <FilterGroup
            label="outcome"
            current={outcome}
            options={outcomes.map((o) => ({ id: o, label: o ?? "All" }))}
            tenantSlug={tenantSlug}
            extra={{ action }}
            param="outcome"
          />
        </div>
      </Card>

      {events.length === 0 ? (
        <p className="rounded-[var(--radius)] border border-dashed border-[var(--stroke-default)] bg-[var(--surface-sunken)] p-12 text-center font-body text-[13px] text-[var(--ink-tertiary)]">
          No matching events. Try clearing filters or do something — every push and upload lands here.
        </p>
      ) : (
        <ol>
          {events.map((e) => (
            <li
              key={e.id}
              className="grid grid-cols-[80px_140px_1fr_120px] gap-4 border-t-[0.5px] border-[var(--stroke-default)] py-3 font-body text-[13px]"
            >
              <span className="font-mono text-[10px] text-[var(--ink-tertiary)]" title={e.createdAt.toISOString()}>
                {relativeTime(e.createdAt)}
              </span>
              <span className="truncate text-[var(--ink-secondary)]" title={e.user?.email ?? ""}>
                {e.user?.displayName ?? "system"}
              </span>
              <span className="min-w-0">
                <code className="font-mono text-[12px] text-[var(--ink-primary)]">{e.action}</code>
                {e.app && (
                  <span className="ml-2 font-body text-[12px] text-[var(--ink-tertiary)]">
                    · {e.app.appName} ({e.app.platform})
                  </span>
                )}
                {e.diff !== null && (
                  <details className="mt-1">
                    <summary className="cursor-pointer font-mono text-[10px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
                      diff
                    </summary>
                    <pre className="mt-1 max-h-32 overflow-auto rounded-[var(--radius-xs)] bg-[var(--surface-sunken)] p-2 font-mono text-[10px]">
                      {JSON.stringify(e.diff, null, 2)}
                    </pre>
                  </details>
                )}
                {e.errorCode && (
                  <code className="mt-1 block font-mono text-[10px] text-[var(--status-danger)]">
                    {e.errorCode}
                  </code>
                )}
              </span>
              <Stamp variant={outcomeStamp(e.outcome)} className="justify-self-end">
                {e.outcome}
              </Stamp>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

function FilterGroup({
  label,
  current,
  options,
  tenantSlug,
  extra,
  param = "action",
}: {
  label: string;
  current: string | null;
  options: { id: string | null; label: string }[];
  tenantSlug: string;
  extra: Record<string, string | null>;
  param?: string;
}): JSX.Element {
  function build(id: string | null): string {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(extra)) if (v) params.set(k, v);
    if (id) params.set(param, id);
    const qs = params.toString();
    return `/t/${tenantSlug}/audit${qs ? `?${qs}` : ""}`;
  }
  return (
    <div className="flex flex-wrap items-center gap-1" role="group" aria-label={label}>
      {options.map((opt) => (
        <a
          key={opt.id ?? "all"}
          href={build(opt.id)}
          className={
            current === opt.id
              ? "rounded-[var(--radius-xs)] bg-[var(--signal-tint)] px-2 py-1 font-mono text-[10px] text-[var(--ink-primary)]"
              : "rounded-[var(--radius-xs)] px-2 py-1 font-mono text-[10px] text-[var(--ink-secondary)] hover:bg-[var(--surface-tinted)]"
          }
        >
          {opt.label}
        </a>
      ))}
    </div>
  );
}
