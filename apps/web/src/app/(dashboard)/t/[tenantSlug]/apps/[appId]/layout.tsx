/**
 * Per-app shell.
 *
 * The header is deliberately compact (single row, 56-72 px) so the
 * actual workbench below has room to breathe. App metadata (icon,
 * name, platform, version, status) lives on the left; primary
 * actions (Smart sync, Push) sit on the right.
 *
 * Five-tab IA replaces the old seven-tab sprawl:
 *
 *     Pulse · Studio · Keywords · Analytics · Library
 *
 * Old paths (`/overview`, `/metadata`, `/aso/*`) redirect into the
 * new structure so existing bookmarks and outbound links keep
 * working. See the redirect-only `page.tsx` files under each old
 * directory.
 */
import Link from "next/link";
import { notFound } from "next/navigation";
import { tenantStorage, prisma } from "@marquee/db";
import { isAppInScope, loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { Stamp } from "@marquee/ui";
import { ChevronLeft } from "lucide-react";
import { AppActionsBar } from "@/components/apps/AppActionsBar";
import { AppShellNav } from "@/components/shell/AppShellNav";
import { PlatformIcon } from "@/components/icons/BrandIcons";

interface LayoutProps {
  children: React.ReactNode;
  params: Promise<{ tenantSlug: string; appId: string }>;
}

export default async function AppDetailLayout({
  children,
  params,
}: LayoutProps): Promise<JSX.Element> {
  const { tenantSlug, appId } = await params;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();
  // Per-member app scoping: a member restricted to specific apps cannot open
  // one outside their scope. notFound() (not Forbidden) so we don't leak that
  // the app exists in the workspace.
  if (!isAppInScope(tenant.allowedAppIds, appId)) notFound();

  // One round-trip inside the tenant context so RLS filters everything.
  // App + dirty count are fetched together to avoid two sequential
  // requests; both feed the topbar.
  const data = await tenantStorage.run(
    {
      tenantId: tenant.id,
      userId: session.user.id,
      role: tenant.role,
      requestId: crypto.randomUUID(),
      allowedAppIds: tenant.allowedAppIds,
    },
    async () => {
      const [app, dirtyCount] = await Promise.all([
        prisma.app.findUnique({
          where: { id: appId },
          select: {
            id: true,
            appName: true,
            bundleId: true,
            platform: true,
            versionString: true,
            status: true,
          },
        }),
        prisma.appLocalization.count({ where: { appId, dirty: true } }),
      ]);
      return app ? { app, dirtyCount } : null;
    },
  );
  if (!data) notFound();
  const { app, dirtyCount } = data;

  return (
    <div className="page-loaded">
      {/* ── Header bar ──────────────────────────────────────────────
       *  Modern app-shell row: rounded icon, bigger app name, bundle +
       *  meta line below, action bar pinned right. */}
      <header className="mb-5 flex flex-wrap items-center justify-between gap-4">
        <div className="flex min-w-0 items-center gap-3">
          <Link
            href={`/t/${tenantSlug}/apps`}
            aria-label="Back to apps list"
            className="grid h-9 w-9 place-items-center rounded-[var(--radius)] text-[var(--ink-tertiary)] transition-colors hover:bg-[var(--surface-tinted)] hover:text-[var(--ink-primary)]"
          >
            <ChevronLeft size={18} />
          </Link>
          <span
            aria-hidden
            className="grid h-11 w-11 shrink-0 place-items-center rounded-[var(--radius-lg)] border border-[var(--stroke-default)] bg-[var(--surface-sunken)] font-display text-[18px] text-[var(--ink-primary)]"
            style={{ fontVariationSettings: "'wght' 600" }}
          >
            {app.appName.charAt(0).toUpperCase()}
          </span>
          <div className="min-w-0">
            <div className="flex items-center gap-2">
              <h1
                className="truncate font-display text-[20px] leading-tight tracking-[-0.01em] text-[var(--ink-primary)]"
                style={{ fontVariationSettings: "'wght' 600" }}
                title={app.appName}
              >
                {app.appName}
              </h1>
              <PlatformIcon platform={app.platform} size={16} className="shrink-0" />
              <Stamp variant={app.platform === "IOS" ? "default" : "success"}>
                {app.platform}
              </Stamp>
              {dirtyCount > 0 && (
                <Stamp variant="warning">{dirtyCount.toString()} pending push</Stamp>
              )}
            </div>
            <p className="mt-0.5 truncate text-[12px] text-[var(--ink-tertiary)]">
              {app.bundleId}
              {app.versionString && (
                <>
                  <span className="mx-1.5 text-[var(--ink-quaternary)]">·</span>
                  v{app.versionString}
                </>
              )}
              {app.status && (
                <>
                  <span className="mx-1.5 text-[var(--ink-quaternary)]">·</span>
                  {app.status.toLowerCase()}
                </>
              )}
            </p>
          </div>
        </div>
        <AppActionsBar
          appId={app.id}
          platform={app.platform}
          dirtyCount={dirtyCount}
        />
      </header>

      {/* ── Primary nav ────────────────────────────────────────────
       *  Modern pill segmented control. Active tab gets a filled
       *  ink-primary background; non-active tabs hover-tint. */}
      <div className="mb-6">
        <AppShellNav
          tenantSlug={tenantSlug}
          appId={appId}
          counts={{ studioDirty: dirtyCount }}
        />
      </div>

      <div>{children}</div>
    </div>
  );
}
