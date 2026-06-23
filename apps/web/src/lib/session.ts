/**
 * Session management. httpOnly cookie holds an opaque token; the SHA-256
 * hash of the token is stored in the DB (Session.tokenHash). Compromising
 * the DB row alone cannot impersonate a user.
 *
 * This module is the authoritative source for what counts as "logged in"
 * and which tenant is active. The middleware uses it; route handlers wrap
 * it with `withTenantContext`.
 */
import { cache } from "react";
import { cookies, headers } from "next/headers";
import { createHash, randomBytes } from "node:crypto";
import { prismaUnscoped } from "@marquee/db";
import { logger } from "./logger";
import { useSecureCookies } from "./cookie-security";

const COOKIE_NAME = process.env.SESSION_COOKIE_NAME ?? "gp_session";
const COOKIE_MAX_AGE_DAYS = Number(process.env.SESSION_TTL_DAYS ?? "7");
const COOKIE_MAX_AGE_SEC = COOKIE_MAX_AGE_DAYS * 24 * 60 * 60;

export interface SessionData {
  sessionId: string;
  userId: string;
  activeTenantId: string | null;
  expiresAt: Date;
}

function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex");
}

export function generateSessionToken(): string {
  return randomBytes(32).toString("base64url");
}

export async function createSession(
  userId: string,
  initialTenantId: string | null,
  meta: { ip?: string; userAgent?: string } = {},
): Promise<{ token: string; expiresAt: Date }> {
  const token = generateSessionToken();
  const expiresAt = new Date(Date.now() + COOKIE_MAX_AGE_SEC * 1000);
  await prismaUnscoped.session.create({
    data: {
      userId,
      activeTenantId: initialTenantId,
      tokenHash: hashToken(token),
      expiresAt,
      ipAddress: meta.ip ?? null,
      userAgent: meta.userAgent ?? null,
    },
  });
  return { token, expiresAt };
}

export async function setSessionCookie(token: string): Promise<void> {
  const store = await cookies();
  store.set(COOKIE_NAME, token, {
    httpOnly: true,
    // eslint-disable-next-line react-hooks/rules-of-hooks -- not a React hook; useSecureCookies is a server-side cookie utility from ./cookie-security
    secure: useSecureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: COOKIE_MAX_AGE_SEC,
  });
}

export async function clearSessionCookie(): Promise<void> {
  const store = await cookies();
  store.delete(COOKIE_NAME);
}

export async function destroySession(token: string): Promise<void> {
  await prismaUnscoped.session.deleteMany({ where: { tokenHash: hashToken(token) } });
}

// Per-request memoised so the layout, page, and every helper that resolves the
// session in a single render/route share ONE DB lookup instead of repeating it.
export const getSessionFromCookie = cache(async (): Promise<SessionData | null> => {
  const store = await cookies();
  const token = store.get(COOKIE_NAME)?.value;
  if (!token) return null;
  return getSessionFromToken(token);
});

/** Don't write lastUsedAt on every request — a sliding window only needs coarse
 *  precision, and a per-request write to the same session row adds latency and
 *  row contention under the many parallel calls a page makes. */
const LAST_USED_REFRESH_MS = 10 * 60_000;

export async function getSessionFromToken(token: string): Promise<SessionData | null> {
  const session = await prismaUnscoped.session.findUnique({
    where: { tokenHash: hashToken(token) },
  });
  if (!session) return null;
  if (session.expiresAt.getTime() < Date.now()) {
    void prismaUnscoped.session.delete({ where: { id: session.id } }).catch((err: unknown) => {
      logger.warn({ err }, "Failed to clean up expired session");
    });
    return null;
  }
  // Sliding window: bump lastUsedAt async, but only when it's actually stale.
  if (Date.now() - session.lastUsedAt.getTime() > LAST_USED_REFRESH_MS) {
    void prismaUnscoped.session
      .update({ where: { id: session.id }, data: { lastUsedAt: new Date() } })
      .catch(() => {
        /* best-effort */
      });
  }
  return {
    sessionId: session.id,
    userId: session.userId,
    activeTenantId: session.activeTenantId,
    expiresAt: session.expiresAt,
  };
}

export async function setActiveTenant(sessionId: string, tenantId: string): Promise<void> {
  await prismaUnscoped.session.update({
    where: { id: sessionId },
    data: { activeTenantId: tenantId },
  });
}

export function requestIp(): string | undefined {
  return undefined;
}

export async function ipFromHeaders(): Promise<string | undefined> {
  const h = await headers();
  return h.get("x-forwarded-for")?.split(",")[0]?.trim() ?? h.get("x-real-ip") ?? undefined;
}

export async function userAgentFromHeaders(): Promise<string | undefined> {
  const h = await headers();
  return h.get("user-agent") ?? undefined;
}

export const SESSION_COOKIE_NAME = COOKIE_NAME;
