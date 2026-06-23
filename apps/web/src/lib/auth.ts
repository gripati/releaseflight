/**
 * Authentication + tenant context helpers for server components and
 * route handlers. Each helper composes session lookup + tenant resolution
 * + RBAC, and runs the rest of the request inside tenantStorage.run so
 * Prisma queries are RLS-scoped.
 */
import { cache } from "react";
import { headers } from "next/headers";
import { redirect } from "next/navigation";
import { prismaUnscoped, tenantStorage, type TenantContext } from "@marquee/db";
import { TenantRole } from "@prisma/client";
import { AuthRequiredError, ForbiddenError, TenantSuspendedError } from "@marquee/core";
import {
  getSessionFromCookie,
  ipFromHeaders,
  userAgentFromHeaders,
  type SessionData,
} from "./session";
import { logger } from "./logger";

export interface AuthenticatedContext {
  session: SessionData;
  user: {
    id: string;
    email: string;
    displayName: string;
    avatarUrl: string | null;
    mustChangePassword: boolean;
  };
  tenant: {
    id: string;
    slug: string;
    name: string;
    status: "ACTIVE" | "SUSPENDED" | "PENDING_DELETE";
    deployedAs: "SELF_HOST" | "SAAS";
  } | null;
  role: TenantRole | null;
  /** Per-member app scope. Empty = unrestricted (every app in the tenant). */
  allowedAppIds: string[];
}

/** Loads the session+user; redirects to /login if missing or expired.
 *  Per-request memoised: a route that calls requireTenant() directly AND wraps
 *  its body in withTenantContext() (which calls requireTenant again) otherwise
 *  re-runs the session+user+membership queries twice per request. */
export const requireSession = cache(async (): Promise<AuthenticatedContext> => {
  const session = await getSessionFromCookie();
  if (!session) {
    redirect("/login");
  }

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
  if (user?.status !== "ACTIVE") {
    redirect("/login");
  }

  let tenant: AuthenticatedContext["tenant"] = null;
  let role: TenantRole | null = null;
  let allowedAppIds: string[] = [];
  if (session.activeTenantId) {
    const membership = await prismaUnscoped.tenantMember.findUnique({
      where: {
        tenantId_userId: {
          tenantId: session.activeTenantId,
          userId: user.id,
        },
      },
      include: {
        tenant: {
          select: {
            id: true,
            slug: true,
            name: true,
            status: true,
            deployedAs: true,
          },
        },
      },
    });
    if (membership) {
      tenant = membership.tenant;
      role = membership.role;
      allowedAppIds = membership.allowedAppIds;
    }
  }

  return {
    session,
    user: {
      id: user.id,
      email: user.email,
      displayName: user.displayName,
      avatarUrl: user.avatarUrl,
      mustChangePassword: user.mustChangePassword,
    },
    tenant,
    role,
    allowedAppIds,
  };
});

/**
 * Same as requireSession but ALSO ensures an active tenant. Builds a
 * TenantContext, wraps the body in tenantStorage.run, and returns the
 * authenticated context plus an exec helper.
 */
export const requireTenant = cache(
  async (): Promise<AuthenticatedContext & { tenantContext: TenantContext }> => {
    const ctx = await requireSession();
    // Server-side enforcement of the forced password change. The dashboard
    // layout redirects page navigations, but that is UI-only: without this gate
    // a provisioned account (or anyone holding the admin-set initial password)
    // could script the API and never rotate the password. The change-password
    // route uses getSessionFromCookie (not requireTenant), so this does not
    // block the user from actually changing it.
    if (ctx.user.mustChangePassword) {
      throw new ForbiddenError("Password change required before continuing");
    }
    if (!ctx.tenant || !ctx.role) {
      redirect("/account/tenants");
    }
    if (ctx.tenant.status === "SUSPENDED") {
      throw new TenantSuspendedError("workspace suspended");
    }
    if (ctx.tenant.status === "PENDING_DELETE") {
      throw new TenantSuspendedError("workspace pending delete");
    }
    const requestId = (await headers()).get("x-request-id") ?? crypto.randomUUID();
    const tenantContext: TenantContext = {
      tenantId: ctx.tenant.id,
      userId: ctx.user.id,
      role: ctx.role,
      requestId,
      // Drives the app.allowed_app_ids RLS GUC so per-member app scoping is
      // enforced at the DB layer across every route that runs in this context.
      allowedAppIds: ctx.allowedAppIds,
    };
    return { ...ctx, tenantContext };
  },
);

/** Executes `fn` inside the AsyncLocalStorage tenant context. */
export async function withTenantContext<T>(
  fn: (ctx: AuthenticatedContext & { tenantContext: TenantContext }) => Promise<T>,
): Promise<T> {
  const ctx = await requireTenant();
  return tenantStorage.run(ctx.tenantContext, async () => fn(ctx));
}

const ROLE_RANK: Record<TenantRole, number> = {
  OWNER: 5,
  ADMIN: 4,
  MAINTAINER: 3,
  EDITOR: 2,
  VIEWER: 1,
};

export function requireRole(role: TenantRole | null, minimum: TenantRole): asserts role {
  if (!role) throw new AuthRequiredError();
  if (ROLE_RANK[role] < ROLE_RANK[minimum]) {
    throw new ForbiddenError(`Role ${role} cannot perform this action (requires ${minimum}+)`);
  }
}

export function requireMembership(role: TenantRole | null): asserts role {
  if (!role) throw new ForbiddenError("Not a member of this workspace");
}

export async function loadTenantBySlug(
  slug: string,
  userId: string,
): Promise<{
  id: string;
  slug: string;
  name: string;
  role: TenantRole;
  allowedAppIds: string[];
} | null> {
  const tenant = await prismaUnscoped.tenant.findUnique({
    where: { slug },
    select: {
      id: true,
      slug: true,
      name: true,
      members: { where: { userId }, select: { role: true, allowedAppIds: true } },
    },
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
}

export async function logRequestMeta(): Promise<{ ip?: string; userAgent?: string }> {
  return {
    ip: await ipFromHeaders(),
    userAgent: await userAgentFromHeaders(),
  };
}

export { TenantRole, logger };
