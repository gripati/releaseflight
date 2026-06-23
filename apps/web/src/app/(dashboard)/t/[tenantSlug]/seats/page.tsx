import { notFound } from "next/navigation";
import { Card, Divider, Stamp } from "@marquee/ui";
import { tenantStorage, prismaUnscoped } from "@marquee/db";
import { getEntitlements } from "@marquee/license";
import { loadTenantBySlug, requireSession } from "@/lib/auth-helpers";
import { getSeatUsage, isBillableRole } from "@/lib/seats";
import { PageHeader } from "@/components/shell/PageHeader";
import { AddMemberSheet } from "@/components/team/AddMemberSheet";
import { MemberRow } from "@/components/team/MemberRow";
import { SeatUsageCard } from "@/components/team/SeatUsageCard";

interface PageProps {
  params: Promise<{ tenantSlug: string }>;
}

const H2 = "mb-1 font-mono text-[10px] uppercase tracking-[0.12em] text-[var(--ink-tertiary)]";
const HINT = "mb-3 font-body text-[12px] leading-relaxed text-[var(--ink-secondary)]";

export default async function SeatsPage({ params }: PageProps): Promise<JSX.Element> {
  const { tenantSlug } = await params;
  const session = await requireSession();
  const tenant = await loadTenantBySlug(tenantSlug, session.user.id);
  if (!tenant) notFound();

  const canManage = tenant.role === "OWNER" || tenant.role === "ADMIN";

  // Seat usage is INSTANCE-WIDE (one distinct active billable user = one seat).
  const usage = await getSeatUsage();
  const ent = getEntitlements();

  const data = await tenantStorage.run(
    { tenantId: tenant.id, userId: session.user.id, role: tenant.role, requestId: crypto.randomUUID() },
    async () => {
      const members = await prismaUnscoped.tenantMember.findMany({
        where: { tenantId: tenant.id },
        include: { user: { select: { id: true, email: true, displayName: true, lastLoginAt: true } } },
        orderBy: { joinedAt: "asc" },
      });
      const apps = canManage
        ? await prismaUnscoped.app.findMany({
            where: { tenantId: tenant.id },
            select: { id: true, appName: true },
            orderBy: { appName: "asc" },
          })
        : [];
      return { members, apps };
    },
  );

  const ownerCount = data.members.filter((m) => m.role === "OWNER").length;
  const appOptions = data.apps.map((a) => ({ id: a.id, name: a.appName }));
  const occupied = data.members.filter((m) => isBillableRole(m.role));
  const viewers = data.members.filter((m) => !isBillableRole(m.role));
  const seatsExhausted = usage.seats !== null && usage.used >= usage.seats;

  const renderRow = (m: (typeof data.members)[number]): JSX.Element => (
    <MemberRow
      key={m.userId}
      tenantSlug={tenantSlug}
      member={{
        userId: m.userId,
        email: m.user.email,
        displayName: m.user.displayName,
        role: m.role,
        joinedAt: m.joinedAt.toISOString(),
        lastLoginAt: m.user.lastLoginAt?.toISOString() ?? null,
        allowedAppIds: m.allowedAppIds,
      }}
      apps={appOptions}
      currentUserId={session.user.id}
      currentUserRole={tenant.role}
      canManage={canManage}
      isLastOwner={m.role === "OWNER" && ownerCount === 1}
    />
  );

  return (
    <div className="page-loaded">
      <PageHeader
        title="Seats"
        eyebrow={usage.seats === null ? `${usage.used.toString()} in use` : `${usage.used.toString()} of ${usage.seats.toString()} used`}
        actions={
          canManage && !seatsExhausted ? (
            <AddMemberSheet tenantSlug={tenantSlug} apps={appOptions} canGrantOwner={tenant.role === "OWNER"} />
          ) : null
        }
      />

      <SeatUsageCard
        used={usage.used}
        seats={usage.seats}
        inThisWorkspace={occupied.length}
        billingState={usage.billingState}
        // Only managers (OWNER/ADMIN) see the billing portal link — a VIEWER has no
        // business with the operator's Polar console.
        manageBillingUrl={canManage ? ent.manageBillingUrl : null}
      />

      <section className="mt-8">
        <h2 className={H2}>Occupied seats — this workspace</h2>
        <p className={HINT}>
          Every member with an <strong>OWNER</strong>, <strong>ADMIN</strong>, <strong>MAINTAINER</strong> or{" "}
          <strong>EDITOR</strong> role holds one seat. Free a seat by removing the member or downgrading
          them to <strong>VIEWER</strong>. A person in several workspaces still counts as one seat.
        </p>
        <Card className="divide-y divide-[var(--stroke-default)] p-0">
          {occupied.length ? (
            occupied.map(renderRow)
          ) : (
            <div className="px-4 py-6 font-body text-[12px] text-[var(--ink-tertiary)]">
              No seat holders in this workspace yet.
            </div>
          )}
        </Card>
        {canManage ? (
          seatsExhausted ? (
            <p className="mt-3 font-body text-[12px] text-[var(--status-warning)]">
              All seats are in use. Free one above, or add seats from billing, before inviting another member.
            </p>
          ) : usage.seats !== null ? (
            <p className="mt-3 font-body text-[12px] text-[var(--ink-tertiary)]">
              {(usage.seats - usage.used).toString()} seat
              {usage.seats - usage.used === 1 ? "" : "s"} available — use “Add member” to assign one.
            </p>
          ) : null
        ) : null}
      </section>

      {viewers.length ? (
        <section className="mt-8">
          <h2 className={H2}>Viewers — no seat</h2>
          <p className={HINT}>Viewers have read-only access and never consume a seat.</p>
          <Card className="divide-y divide-[var(--stroke-default)] p-0">{viewers.map(renderRow)}</Card>
        </section>
      ) : null}

      <Divider className="my-8" />

      <section>
        <h2 className={H2}>Roles</h2>
        <p className={HINT}>
          A member&apos;s role sets both what they can do and whether they hold a seat. Change it from the
          menu on any member above.
        </p>
        <Card>
          <dl className="grid grid-cols-1 gap-x-6 gap-y-2 sm:grid-cols-[140px_1fr]">
            <dt><Stamp variant="default">OWNER</Stamp></dt>
            <dd className="font-body text-[12px] text-[var(--ink-secondary)]">
              Full control, including billing (SaaS) and workspace deletion. Holds a seat.
            </dd>
            <dt><Stamp variant="info">ADMIN</Stamp></dt>
            <dd className="font-body text-[12px] text-[var(--ink-secondary)]">
              Manage credentials, apps and members. Holds a seat.
            </dd>
            <dt><Stamp variant="info">MAINTAINER</Stamp></dt>
            <dd className="font-body text-[12px] text-[var(--ink-secondary)]">
              Manage credentials and connect / disconnect apps. Holds a seat.
            </dd>
            <dt><Stamp variant="success">EDITOR</Stamp></dt>
            <dd className="font-body text-[12px] text-[var(--ink-secondary)]">
              Edit metadata and push to stores. Holds a seat.
            </dd>
            <dt><Stamp>VIEWER</Stamp></dt>
            <dd className="font-body text-[12px] text-[var(--ink-secondary)]">
              Read-only access. Free — never consumes a seat.
            </dd>
          </dl>
        </Card>
      </section>
    </div>
  );
}
