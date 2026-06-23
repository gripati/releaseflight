import { notFound, redirect } from "next/navigation";
import { loadTenantBySlug, requireSession, setActiveTenantInSession } from "@/lib/auth-helpers";
import { TenantShell } from "@/components/shell/TenantShell";
import { seatsPageEnabled } from "@/lib/seats";
import { prisma } from "@marquee/db";
import { tenantStorage } from "@marquee/db";

interface LayoutProps {
  children: React.ReactNode;
  params: Promise<{ tenantSlug: string }>;
}

export default async function TenantLayout({ children, params }: LayoutProps): Promise<JSX.Element> {
  const { tenantSlug } = await params;
  const session = await requireSession();
  // Admin-provisioned accounts must set their own password before doing
  // anything else in the workspace.
  if (session.user.mustChangePassword) redirect("/change-password");
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();

  // Keep session.activeTenantId in sync as a convenience default, but never
  // block the shell render on it — fire-and-forget so navigation isn't gated
  // on a DB write. RLS + the URL slug are the source of truth, not this field.
  if (session.session.activeTenantId !== tenant.id) {
    void setActiveTenantInSession(session.session.sessionId, tenant.id).catch(() => {
      /* best-effort */
    });
  }

  // Counts loaded inside tenant context so RLS filters. Parallelised.
  const counts = await tenantStorage.run(
    {
      tenantId: tenant.id,
      userId: session.user.id,
      role: tenant.role,
      requestId: crypto.randomUUID(),
    },
    async () => {
      const [apps, jobs] = await Promise.all([
        prisma.app.count(),
        prisma.job.count({ where: { status: { in: ["QUEUED", "RUNNING"] } } }),
      ]);
      return { apps, jobs };
    },
  );

  // Show the Seats (members + seats) page only for multi-seat / unlimited licences;
  // a solo licence has no team, so the entry is hidden.
  const showSeats = seatsPageEnabled();
  // Release version, baked into the runtime image by CI (ENV APP_VERSION). Null on a
  // dev build → the sidebar falls back to its status label.
  const appVersion = process.env.APP_VERSION || null;

  return (
    <TenantShell
      tenantSlug={tenant.slug}
      topbar={{
        tenantName: tenant.name,
        tenantSlug: tenant.slug,
        userDisplayName: session.user.displayName,
        userEmail: session.user.email,
        showSeats,
      }}
      sidebar={{ tenantSlug: tenant.slug, counts, showSeats, appVersion }}
    >
      {children}
    </TenantShell>
  );
}
