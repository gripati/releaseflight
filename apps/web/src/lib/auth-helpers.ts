/**
 * Server-component-friendly helpers for tenant layouts. Avoids the
 * route-handler-only `withApiErrors` wrappers.
 *
 * Both helpers are wrapped in React's `cache()` so a layout + its page
 * that both call `requireSession()` only hit the DB once per request.
 */
import { cache } from "react";
import { redirect } from "next/navigation";
import { prismaUnscoped } from "@marquee/db";
import { ForbiddenError } from "@marquee/core";
import type { TenantRole } from "@prisma/client";
import { getSessionFromCookie, type SessionData } from "./session";

export interface SessionContext {
  session: SessionData;
  user: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    mustChangePassword: boolean;
  };
}

export const requireSession = cache(async (): Promise<SessionContext> => {
  const session = await getSessionFromCookie();
  if (!session) redirect("/login");
  const user = await prismaUnscoped.user.findUnique({
    where: { id: session.userId },
    select: {
      id: true,
      email: true,
      displayName: true,
      avatarUrl: true,
      status: true,
      mustChangePassword: true,
    },
  });
  if (user?.status !== "ACTIVE") redirect("/login");
  return {
    session,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      mustChangePassword: user.mustChangePassword,
    },
  };
});

export const loadTenantBySlug = cache(
  async (
    slug: string,
    userId: string,
  ): Promise<{
    id: string;
    slug: string;
    name: string;
    role: TenantRole;
    allowedAppIds: string[];
  } | null> => {
    const tenant = await prismaUnscoped.tenant.findUnique({
      where: { slug },
      include: { members: { where: { userId }, select: { role: true, allowedAppIds: true } } },
    });
    if (!tenant) return null;
    const membership = tenant.members[0];
    if (!membership) return null;
    return {
      id: tenant.id,
      slug: tenant.slug,
      name: tenant.name,
      role: membership.role,
      allowedAppIds: membership.allowedAppIds,
    };
  },
);

/**
 * Per-member app scoping. A member with a NON-EMPTY `allowedAppIds` may only
 * touch those apps; an EMPTY list means unrestricted access to every app in
 * the workspace (the default). Throws ForbiddenError when an app is out of
 * scope — call `isAppInScope` instead where a 404 (notFound) is preferred,
 * e.g. server components, so existence isn't leaked.
 */
export function isAppInScope(allowedAppIds: string[] | undefined, appId: string): boolean {
  if (!allowedAppIds || allowedAppIds.length === 0) return true;
  return allowedAppIds.includes(appId);
}

export function assertAppAccess(allowedAppIds: string[] | undefined, appId: string): void {
  if (!isAppInScope(allowedAppIds, appId)) {
    throw new ForbiddenError("You don't have access to this app");
  }
}

export async function setActiveTenantInSession(sessionId: string, tenantId: string): Promise<void> {
  await prismaUnscoped.session.update({
    where: { id: sessionId },
    data: { activeTenantId: tenantId },
  });
}
