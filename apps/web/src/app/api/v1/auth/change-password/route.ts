/**
 * Authenticated password change. Used both for the forced first-login change
 * (admin-provisioned accounts) and for voluntary changes. Verifies the current
 * password, stores a new Argon2id hash, and clears `mustChangePassword`.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import argon2 from "argon2";
import { AuthRequiredError, RateLimitError, ValidationError } from "@marquee/core";
import { prismaUnscoped } from "@marquee/db";
import { rateLimit } from "@marquee/cache";
import { withApiErrors } from "@/lib/responses";
import {
  getSessionFromCookie,
  createSession,
  setSessionCookie,
  ipFromHeaders,
  userAgentFromHeaders,
} from "@/lib/session";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";

const Body = z.object({
  currentPassword: z.string().min(1).max(256),
  newPassword: z.string().min(12).max(256),
});

export const POST = withApiErrors(async (req: NextRequest) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const session = await getSessionFromCookie();
  if (!session) throw new AuthRequiredError();

  // Rate-limit BEFORE the expensive Argon2 verify: prevents both online
  // guessing of the current password and a CPU/memory-amplification DoS
  // (each verify is a 64 MiB multi-pass hash).
  const minute = Math.floor(Date.now() / 60_000);
  const rl = await rateLimit({
    key: `global:pwchange:${session.userId}:${minute.toString()}`,
    limit: 5,
  });
  if (!rl.allowed) throw new RateLimitError(rl.resetSeconds);

  const body = Body.parse(await req.json());
  if (body.newPassword === body.currentPassword) {
    throw new ValidationError("New password must differ from the current one");
  }

  const user = await prismaUnscoped.user.findUnique({
    where: { id: session.userId },
    select: { id: true, passwordHash: true, status: true },
  });
  if (user?.status !== "ACTIVE" || !user.passwordHash) {
    throw new AuthRequiredError();
  }

  const ok = await argon2.verify(user.passwordHash, body.currentPassword).catch(() => false);
  if (!ok) throw new ValidationError("Current password is incorrect");

  const passwordHash = await argon2.hash(body.newPassword, {
    type: argon2.argon2id,
    memoryCost: 65_536,
    timeCost: 3,
    parallelism: 4,
  });
  await prismaUnscoped.user.update({
    where: { id: user.id },
    data: { passwordHash, mustChangePassword: false },
  });

  // Containment: invalidate EVERY existing session for this user (logs out
  // other devices and any attacker holding a stolen token), then mint a fresh
  // session for the current device so the user stays logged in with a rotated
  // token. A password change is a standard breach-remediation step — it must
  // not leave previously-issued tokens valid.
  await prismaUnscoped.session.deleteMany({ where: { userId: user.id } });
  const ip = await ipFromHeaders();
  const userAgent = await userAgentFromHeaders();
  const { token } = await createSession(user.id, session.activeTenantId, { ip, userAgent });
  await setSessionCookie(token);

  return NextResponse.json({ ok: true, redirectTo: "/account/tenants" });
});
