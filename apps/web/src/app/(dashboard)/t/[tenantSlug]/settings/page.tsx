import Link from "next/link";
import { notFound } from "next/navigation";
import { tenantStorage, prisma } from "@marquee/db";
import { Card, Divider, Stamp } from "@marquee/ui";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { seatsPageEnabled } from "@/lib/seats";
import { PageHeader } from "@/components/shell/PageHeader";
import { ThemeSwitcher } from "@/components/shell/ThemeSwitcher";

interface PageProps {
  params: Promise<{ tenantSlug: string }>;
}

export default async function SettingsPage({ params }: PageProps): Promise<JSX.Element> {
  const { tenantSlug } = await params;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();

  const counts = await tenantStorage.run(
    { tenantId: tenant.id, userId: session.user.id, role: tenant.role, requestId: crypto.randomUUID() },
    async () => {
      const [apps, credentials, members] = await Promise.all([
        prisma.app.count(),
        prisma.credential.count(),
        prisma.tenantMember.count(),
      ]);
      return { apps, credentials, members };
    },
  );

  const fullTenant = await prisma.tenant.findUnique({
    where: { id: tenant.id },
    select: { name: true, slug: true, deployedAs: true, planTier: true, createdAt: true },
  });

  return (
    <div className="page-loaded space-y-10">
      <PageHeader title="Settings" eyebrow={`Workspace · ${tenant.slug}`} />

      <section>
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
          Profile
        </h2>
        <Card>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[160px_1fr]">
            <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
              Display name
            </dt>
            <dd className="font-body text-[14px]">{session.user.displayName}</dd>
            <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
              Email
            </dt>
            <dd className="font-mono text-[12px]">{session.user.email}</dd>
            <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
              Role in this workspace
            </dt>
            <dd>
              <Stamp variant={tenant.role === "OWNER" ? "default" : "info"}>{tenant.role}</Stamp>
            </dd>
          </dl>
        </Card>
      </section>

      <Divider />

      <section>
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
          Workspace
        </h2>
        <Card>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-3 sm:grid-cols-[160px_1fr]">
            <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
              Name
            </dt>
            <dd className="font-display text-[20px] leading-tight">{fullTenant?.name}</dd>
            <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
              Slug
            </dt>
            <dd className="font-mono text-[12px]">{fullTenant?.slug}</dd>
            <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
              Mode
            </dt>
            <dd>
              <Stamp variant={fullTenant?.deployedAs === "SELF_HOST" ? "info" : "success"}>
                {fullTenant?.deployedAs}
              </Stamp>
            </dd>
            <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
              Plan
            </dt>
            <dd>
              <Stamp>{fullTenant?.planTier ?? "—"}</Stamp>
            </dd>
            <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
              Created
            </dt>
            <dd className="font-mono text-[12px]">
              {fullTenant?.createdAt
                ? new Intl.DateTimeFormat("en-US", { dateStyle: "medium" }).format(
                    fullTenant.createdAt,
                  )
                : "—"}
            </dd>
            <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
              Apps
            </dt>
            <dd className="font-mono text-[12px]">{counts.apps}</dd>
            <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
              Credentials
            </dt>
            <dd className="font-mono text-[12px]">{counts.credentials}</dd>
            <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
              Members
            </dt>
            <dd className="font-mono text-[12px]">{counts.members}</dd>
          </dl>
        </Card>
      </section>

      <Divider />

      <section>
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
          ASO Intelligence
        </h2>
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="font-display text-[18px] leading-tight">AI providers</h3>
              <p className="mt-1 font-body text-[12px] text-[var(--ink-secondary)]">
                Pick which model runs your ASO suggestions. Configure a primary + ordered
                fallbacks — your choice is never overridden by a default.
              </p>
            </div>
            <Link
              href={`/t/${tenant.slug}/settings/ai`}
              className="rounded-[var(--radius-sm)] border-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-elevated)] px-4 py-2 font-mono text-[11px] uppercase tracking-[0.08em] hover:bg-[var(--surface-tinted)]"
            >
              Open AI settings →
            </Link>
          </div>
        </Card>
      </section>

      <Divider />

      <section>
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
          License
        </h2>
        <Card>
          <div className="flex flex-wrap items-center justify-between gap-4">
            <div>
              <h3 className="font-display text-[18px] leading-tight">Installation license</h3>
              <p className="mt-1 font-body text-[12px] text-[var(--ink-secondary)]">
                Activate this machine, check the license state, or transfer your seat from
                another computer.
              </p>
            </div>
            <Link
              href={`/t/${tenant.slug}/settings/license`}
              className="rounded-[var(--radius-sm)] border-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-elevated)] px-4 py-2 font-mono text-[11px] uppercase tracking-[0.08em] hover:bg-[var(--surface-tinted)]"
            >
              Open license settings →
            </Link>
          </div>
        </Card>
      </section>

      {/* Only when the licence has a team to manage (matches the gated Seats nav). */}
      {seatsPageEnabled() ? (
        <>
          <Divider />
          <section>
            <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
              Seats &amp; members
            </h2>
            <Card>
              <div className="flex flex-wrap items-center justify-between gap-4">
                <div>
                  <h3 className="font-display text-[18px] leading-tight">Member seats</h3>
                  <p className="mt-1 font-body text-[12px] text-[var(--ink-secondary)]">
                    See how many seats are in use, which member holds each, free a seat, or assign one to a
                    new teammate.
                  </p>
                </div>
                <Link
                  href={`/t/${tenant.slug}/seats`}
                  className="rounded-[var(--radius-sm)] border-[0.5px] border-[var(--stroke-default)] bg-[var(--surface-elevated)] px-4 py-2 font-mono text-[11px] uppercase tracking-[0.08em] hover:bg-[var(--surface-tinted)]"
                >
                  Manage seats →
                </Link>
              </div>
            </Card>
          </section>
        </>
      ) : null}

      <Divider />

      <section>
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
          Preferences
        </h2>
        <Card>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-4 sm:grid-cols-[160px_1fr]">
            <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
              Theme
            </dt>
            <dd>
              <ThemeSwitcher />
              <p className="mt-2 font-body text-[11px] text-[var(--ink-tertiary)]">
                Stored locally; system follows your OS setting.
              </p>
            </dd>
            <dt className="font-mono text-[11px] uppercase tracking-[0.08em] text-[var(--ink-tertiary)]">
              Keyboard
            </dt>
            <dd className="space-y-1 font-mono text-[11px] text-[var(--ink-secondary)]">
              <p>
                <kbd className="rounded border border-[var(--stroke-default)] px-1">⌘K</kbd>{" "}
                Command palette
              </p>
              <p>
                <kbd className="rounded border border-[var(--stroke-default)] px-1">Esc</kbd>{" "}
                Close any sheet / lightbox
              </p>
            </dd>
          </dl>
        </Card>
      </section>

      <Divider />

      <section>
        <h2 className="mb-3 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]">
          Session
        </h2>
        <Card>
          <p className="mb-3 font-body text-[13px] text-[var(--ink-secondary)]">
            End this session and return to the sign-in page.
          </p>
          <form action="/api/v1/auth/logout" method="POST">
            <button
              type="submit"
              className="inline-flex h-9 items-center gap-2 rounded-[var(--radius-sm)] bg-[var(--status-danger)] px-4 font-body text-[13px] text-white transition-opacity hover:opacity-90"
            >
              Sign out
            </button>
          </form>
        </Card>
      </section>
    </div>
  );
}
