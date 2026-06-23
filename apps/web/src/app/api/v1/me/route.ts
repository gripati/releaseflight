import { NextResponse } from "next/server";
import { prismaUnscoped } from "@marquee/db";
import { getSessionFromCookie } from "@/lib/session";
import { AuthRequiredError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";

export const dynamic = "force-dynamic";

export const GET = withApiErrors(async () => {
  const session = await getSessionFromCookie();
  if (!session) throw new AuthRequiredError();

  const user = await prismaUnscoped.user.findUnique({
    where: { id: session.userId },
    select: { id: true, email: true, displayName: true, avatarUrl: true },
  });
  if (!user) throw new AuthRequiredError();

  let activeTenant: {
    id: string;
    slug: string;
    name: string;
    role: "OWNER" | "ADMIN" | "MAINTAINER" | "EDITOR" | "VIEWER";
  } | null = null;

  if (session.activeTenantId) {
    const m = await prismaUnscoped.tenantMember.findUnique({
      where: { tenantId_userId: { tenantId: session.activeTenantId, userId: user.id } },
      include: { tenant: { select: { id: true, slug: true, name: true } } },
    });
    if (m) {
      activeTenant = { id: m.tenant.id, slug: m.tenant.slug, name: m.tenant.name, role: m.role };
    }
  }

  return NextResponse.json({ user, activeTenant });
});
