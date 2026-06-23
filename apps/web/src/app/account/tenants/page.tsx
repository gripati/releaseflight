import { redirect } from "next/navigation";
import Link from "next/link";
import { Button, Card, Divider } from "@marquee/ui";
import { prismaUnscoped } from "@marquee/db";
import { requireSession } from "@/lib/auth-helpers";
import { PageHeader } from "@/components/shell/PageHeader";

export const dynamic = "force-dynamic";

export default async function TenantPickerPage(): Promise<JSX.Element> {
  const ctx = await requireSession();
  // Admin-provisioned accounts must set their own password first.
  if (ctx.user.mustChangePassword) redirect("/change-password");
  const memberships = await prismaUnscoped.tenantMember.findMany({
    where: { userId: ctx.user.id },
    include: {
      tenant: {
        select: {
          id: true,
          slug: true,
          name: true,
          status: true,
          planTier: true,
          trialEndsAt: true,
          _count: { select: { apps: true } },
        },
      },
    },
    orderBy: { joinedAt: "asc" },
  });

  if (memberships.length === 1) {
    // Sole membership: skip the picker and land on /apps directly —
    // the tenant Dashboard page was retired, /apps is the canonical
    // first surface inside a workspace.
    redirect(`/t/${memberships[0]!.tenant.slug}/apps`);
  }

  return (
    <div className="mx-auto min-h-screen max-w-2xl px-6 py-16 page-loaded">
      <PageHeader
        eyebrow="Choose your workspace"
        title="Where to today?"
        description="You belong to multiple workspaces. Pick one to continue."
      />
      {memberships.length === 0 ? (
        <Card>
          <p className="font-body text-[14px]">
            You don't belong to any workspace yet. Wait for an invitation or contact your admin.
          </p>
        </Card>
      ) : (
        <ul className="flex flex-col gap-3">
          {memberships.map((m) => (
            <li key={m.tenantId}>
              <Link
                href={`/t/${m.tenant.slug}/apps`}
                className="block transition-transform duration-[160ms] hover:-translate-y-px"
              >
                <Card>
                  <div className="flex items-center gap-4">
                    <span
                      className="grid h-12 w-12 place-items-center rounded-full bg-[var(--surface-tinted)] font-display text-xl"
                      style={{ fontVariationSettings: "'wght' 500" }}
                    >
                      {m.tenant.name.charAt(0).toUpperCase()}
                    </span>
                    <div className="flex-1">
                      <h3 className="font-display text-lg">{m.tenant.name}</h3>
                      <p className="font-mono text-[11px] text-[var(--ink-tertiary)]">
                        {m.tenant.slug} · {m.role} · {m.tenant._count.apps} app{m.tenant._count.apps === 1 ? "" : "s"} · {m.tenant.planTier}
                      </p>
                    </div>
                    <span className="font-body text-[12px] text-[var(--ink-secondary)]">→</span>
                  </div>
                </Card>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <Divider className="my-8" />
      <form action="/api/v1/auth/logout" method="POST">
        <Button variant="ghost" size="sm" type="submit">
          Sign out
        </Button>
      </form>
    </div>
  );
}
