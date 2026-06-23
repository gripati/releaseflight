import { NextResponse } from "next/server";
import { prismaUnscoped } from "@marquee/db";
import { redis } from "@marquee/cache";
import { createSecretProvider } from "@marquee/secrets";
import { logger } from "@/lib/logger";

export const dynamic = "force-dynamic";

/**
 * This endpoint is UNAUTHENTICATED (probed by load balancers / k8s). It must
 * return only a boolean per subsystem — never the raw error message, which
 * leaks DB host/port/role, Redis address, and secret-provider paths to anyone
 * who can reach it during an outage. Detail is logged server-side only. The
 * authenticated `/health/deep` route may surface messages.
 */
export async function GET(): Promise<NextResponse> {
  const checks: Record<string, { ok: boolean }> = {};

  // DB
  try {
    await prismaUnscoped.$queryRaw`SELECT 1`;
    checks.db = { ok: true };
  } catch (err: unknown) {
    logger.error({ err }, "readyz: DB check failed");
    checks.db = { ok: false };
  }

  // Redis
  try {
    const pong = await redis.ping();
    checks.redis = { ok: pong === "PONG" };
  } catch (err: unknown) {
    logger.error({ err }, "readyz: Redis check failed");
    checks.redis = { ok: false };
  }

  // Secret provider
  try {
    const sp = createSecretProvider();
    const res = sp.healthCheck ? await sp.healthCheck() : { ok: true };
    if (!res.ok) logger.error({ message: res.message }, "readyz: secret provider not ready");
    checks.secrets = { ok: res.ok };
  } catch (err: unknown) {
    logger.error({ err }, "readyz: secret provider check failed");
    checks.secrets = { ok: false };
  }

  const allOk = Object.values(checks).every((c) => c.ok);
  return NextResponse.json({ status: allOk ? "ready" : "not_ready", checks }, { status: allOk ? 200 : 503 });
}
