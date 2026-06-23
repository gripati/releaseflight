import { NextResponse, type NextRequest } from "next/server";
import argon2 from "argon2";
import { LoginRequest, type LoginResponse } from "@marquee/api-contracts";
import { prismaUnscoped } from "@marquee/db";
import { AuthRequiredError, RateLimitError } from "@marquee/core";
import { rateLimit } from "@marquee/cache";
import {
  createSession,
  setSessionCookie,
  ipFromHeaders,
  userAgentFromHeaders,
} from "@/lib/session";
import { withApiErrors } from "@/lib/responses";
import { assertCsrf, CSRF_HEADER, ensureCsrfToken } from "@/lib/csrf";
import { clientIp } from "@/lib/rateLimitWrap";
import { logger } from "@/lib/logger";

async function pickActiveTenant(userId: string): Promise<string | null> {
  const user = await prismaUnscoped.user.findUnique({
    where: { id: userId },
    select: { defaultTenantId: true },
  });
  if (user?.defaultTenantId) {
    const membership = await prismaUnscoped.tenantMember.findUnique({
      where: { tenantId_userId: { tenantId: user.defaultTenantId, userId } },
    });
    if (membership) return user.defaultTenantId;
  }
  const first = await prismaUnscoped.tenantMember.findFirst({
    where: { userId },
    orderBy: { joinedAt: "asc" },
  });
  return first?.tenantId ?? null;
}

async function enforceLoginRateLimit(req: NextRequest, email: string): Promise<void> {
  const minute = Math.floor(Date.now() / 60_000);
  const ip = clientIp(req);
  const ipResult = await rateLimit({
    key: `global:login:ip:${ip}:${minute.toString()}`,
    limit: 10,
  });
  if (!ipResult.allowed) throw new RateLimitError(ipResult.resetSeconds);
  const emailResult = await rateLimit({
    key: `global:login:email:${email.toLowerCase()}:${minute.toString()}`,
    limit: 5,
  });
  if (!emailResult.allowed) throw new RateLimitError(emailResult.resetSeconds);
}

export const POST = withApiErrors(async (req: NextRequest) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));

  // Do NOT log the raw request body — it carries the plaintext password and
  // the user's email. Parse it straight into the validated shape instead.
  const raw = await req.json().catch(() => null);
  const body = LoginRequest.parse(raw);
  await enforceLoginRateLimit(req, body.email);

  const user = await prismaUnscoped.user.findUnique({
    where: { email: body.email.toLowerCase() },
  });

  const hashToVerify =
    user?.passwordHash ??
    "$argon2id$v=19$m=65536,t=3,p=4$AAAAAAAAAAAAAAAAAAAAAA$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA";
  const ok = await argon2.verify(hashToVerify, body.password).catch(() => false);

  if (!user || !ok || user.status !== "ACTIVE") {
    logger.warn({ email: body.email }, "Login failed");
    throw new AuthRequiredError("Invalid email or password");
  }

  await prismaUnscoped.user.update({
    where: { id: user.id },
    data: { lastLoginAt: new Date() },
  });

  const tenantId = await pickActiveTenant(user.id);
  const ip = await ipFromHeaders();
  const userAgent = await userAgentFromHeaders();

  const { token } = await createSession(user.id, tenantId, { ip, userAgent });
  await setSessionCookie(token);
  await ensureCsrfToken();

  let redirectTo = "/account/tenants";
  if (tenantId) {
    const tenant = await prismaUnscoped.tenant.findUnique({
      where: { id: tenantId },
      select: { slug: true },
    });
    // Post-login landing is /apps — the tenant Dashboard page was
    // retired. Operators want to see their app list first.
    if (tenant) redirectTo = `/t/${tenant.slug}/apps`;
  }

  const response: LoginResponse = { ok: true, redirectTo };
  return NextResponse.json(response);
});
