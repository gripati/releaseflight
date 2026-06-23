import Link from "next/link";
import { notFound } from "next/navigation";
import { Card, StateDot, Stamp, Button } from "@marquee/ui";
import { Package } from "lucide-react";
import { tenantStorage, prisma } from "@marquee/db";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { PageHeader } from "@/components/shell/PageHeader";
import { AppsToolbar } from "@/components/apps/AppsToolbar";
import { PlatformIcon } from "@/components/icons/BrandIcons";

interface PageProps {
  params: Promise<{ tenantSlug: string }>;
}

export default async function AppsPage({ params }: PageProps): Promise<JSX.Element> {
  const { tenantSlug } = await params;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();

  // Per-member app scoping: a restricted member only sees their allowed apps.
  // Empty allowedAppIds = unrestricted (the `undefined` where-clause).
  const appScope =
    tenant.allowedAppIds.length > 0 ? { id: { in: tenant.allowedAppIds } } : undefined;
  const apps = await tenantStorage.run(
    {
      tenantId: tenant.id,
      userId: session.user.id,
      role: tenant.role,
      requestId: crypto.randomUUID(),
      allowedAppIds: tenant.allowedAppIds,
    },
    async () =>
      prisma.app.findMany({
        where: appScope,
        orderBy: { createdAt: "desc" },
        include: { _count: { select: { localizations: { where: { dirty: true } } } } },
      }),
  );

  return (
    <div className="page-loaded">
      <PageHeader
        title="Apps"
        eyebrow={`${apps.length} connected`}
        description="Every app you manage in this workspace."
        actions={<AppsToolbar tenantSlug={tenantSlug} />}
      />

      {apps.length === 0 ? (
        <EmptyAppsState tenantSlug={tenantSlug} />
      ) : (
        <ul className="grid grid-cols-1 gap-4 md:grid-cols-2">
          {apps.map((app) => (
            <li key={app.id}>
              <Link
                href={`/t/${tenantSlug}/apps/${app.id}/pulse`}
                className="block transition-transform duration-[160ms] hover:-translate-y-px"
              >
                <Card className="flex flex-col gap-3">
                  <div className="flex items-center justify-between">
                    <div className="flex items-center gap-3">
                      <StateDot
                        state={
                          app._count.localizations > 0
                            ? "dirty"
                            : app.isConnected
                              ? "synced"
                              : "empty"
                        }
                      />
                      <PlatformIcon platform={app.platform} size={16} className="shrink-0" />
                      <Stamp variant={app.platform === "IOS" ? "default" : "success"}>
                        {app.platform}
                      </Stamp>
                    </div>
                    <span className="font-mono text-[11px] text-[var(--ink-tertiary)]">
                      {app.versionString ?? "—"}
                    </span>
                  </div>
                  <h3
                    className="font-display text-xl leading-tight tracking-[-0.01em] text-[var(--ink-primary)]"
                    style={{ fontVariationSettings: "'wght' 500" }}
                  >
                    {app.appName}
                  </h3>
                  <p className="font-mono text-[11px] text-[var(--ink-tertiary)]">{app.bundleId}</p>
                  <dl className="grid grid-cols-2 gap-x-4 gap-y-1 font-body text-[12px] text-[var(--ink-secondary)]">
                    <dt className="text-[var(--ink-tertiary)]">Status</dt>
                    <dd>{app.status ?? "—"}</dd>
                    <dt className="text-[var(--ink-tertiary)]">Locales</dt>
                    <dd>{app.availableLanguages.length}</dd>
                    <dt className="text-[var(--ink-tertiary)]">Last fetch</dt>
                    <dd>
                      {app.lastFetchedAt ? new Date(app.lastFetchedAt).toLocaleDateString() : "—"}
                    </dd>
                  </dl>
                  {app._count.localizations > 0 ? (
                    <p className="font-body text-[12px] text-[var(--status-warning)]">
                      ⊙ {app._count.localizations} unpushed edit
                      {app._count.localizations === 1 ? "" : "s"}
                    </p>
                  ) : null}
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

function EmptyAppsState({ tenantSlug }: { tenantSlug: string }): JSX.Element {
  return (
    <div className="mx-auto max-w-xl py-16 text-center">
      <p className="mb-4 font-mono text-[10px] uppercase tracking-[0.18em] text-[var(--ink-tertiary)]">
        ━━━━  EDITION ZERO  ━━━━
      </p>
      <h2
        className="font-display text-[42px] leading-[1.05] tracking-[-0.01em] text-[var(--ink-primary)]"
        style={{ fontVariationSettings: "'wght' 600" }}
      >
        Let's publish your{" "}
        <em className="not-italic font-bold" style={{ color: "var(--signal)" }}>
          first story.
        </em>
      </h2>
      <p className="mx-auto mt-4 max-w-md font-body text-[13px] leading-[1.6] text-[var(--ink-secondary)]">
        Connect an iOS or Android app to start managing metadata, screenshots and submissions
        across stores.
      </p>
      <div
        className="mx-auto mt-6 h-[6px] w-[120px] -rotate-[2deg]"
        style={{ background: "var(--signal)" }}
      />
      <div className="mt-8 flex justify-center">
        <AppsToolbarFallback tenantSlug={tenantSlug} />
      </div>
    </div>
  );
}

function AppsToolbarFallback({ tenantSlug }: { tenantSlug: string }): JSX.Element {
  void Button; // kept for future
  return (
    <span className="inline-flex">
      <AppsToolbar tenantSlug={tenantSlug} />
      <Package size={0} className="hidden" />
    </span>
  );
}
