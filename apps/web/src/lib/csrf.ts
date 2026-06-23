/**
 * CSRF protection — double-submit cookie pattern.
 *
 * 1. On any GET we set `gp_csrf` (NON-httpOnly) with a random token if absent.
 * 2. Every mutating request (POST/PUT/PATCH/DELETE) must echo the token via
 *    the `x-csrf-token` request header.
 * 3. We compare the header against the cookie. Since the cookie is SameSite=Lax,
 *    a cross-origin request cannot read it; an attacker cannot forge the header.
 *
 * This is layered on top of SameSite cookies as defence in depth.
 */
import { cookies } from "next/headers";
import { randomBytes, timingSafeEqual } from "node:crypto";
import { ForbiddenError } from "@marquee/core";
import { useSecureCookies } from "./cookie-security";

export const CSRF_COOKIE = "gp_csrf";
export const CSRF_HEADER = "x-csrf-token";

export async function ensureCsrfToken(): Promise<string> {
  const store = await cookies();
  const existing = store.get(CSRF_COOKIE)?.value;
  if (existing && existing.length >= 32) return existing;
  const token = randomBytes(32).toString("base64url");
  store.set(CSRF_COOKIE, token, {
    httpOnly: false,
    // eslint-disable-next-line react-hooks/rules-of-hooks -- not a React hook; useSecureCookies is a server-side cookie utility from ./cookie-security
    secure: useSecureCookies(),
    sameSite: "lax",
    path: "/",
    maxAge: 60 * 60 * 24 * 7,
  });
  return token;
}

export async function readCsrfCookie(): Promise<string | null> {
  return (await cookies()).get(CSRF_COOKIE)?.value ?? null;
}

export async function assertCsrf(headerValue: string | null): Promise<void> {
  const cookieValue = await readCsrfCookie();
  if (!cookieValue || !headerValue) {
    throw new ForbiddenError("CSRF token missing");
  }
  const a = Buffer.from(cookieValue);
  const b = Buffer.from(headerValue);
  if (a.length !== b.length || !timingSafeEqual(a, b)) {
    throw new ForbiddenError("CSRF token mismatch");
  }
}
