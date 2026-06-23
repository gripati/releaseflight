/**
 * Deep health endpoint — protected (requires session). Exposes subsystem
 * latencies and queue depths so the on-call can quickly see what's wrong
 * without ssh-ing into a node.
 */
import { type NextRequest, NextResponse } from "next/server";
import { prismaUnscoped } from "@marquee/db";
import { redis } from "@marquee/cache";
import { createSecretProvider } from "@marquee/secrets";
import { storage } from "@marquee/storage";
import { ForbiddenError } from "@marquee/core";
import { getSessionFromCookie } from "@/lib/session";
import { withApiErrors } from "@/lib/responses";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface SubsystemCheck {
  ok: boolean;
  latencyMs?: number;
  message?: string;
  extra?: Record<string, unknown>;
}

async function checkDatabase(): Promise<SubsystemCheck> {
  const start = Date.now();
  try {
    await prismaUnscoped.$queryRaw`SELECT 1`;
    return { ok: true, latencyMs: Date.now() - start };
  } catch (err: unknown) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function checkRedis(): Promise<SubsystemCheck> {
  const start = Date.now();
  try {
    const pong = await redis.ping();
    return { ok: pong === "PONG", latencyMs: Date.now() - start };
  } catch (err: unknown) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function checkStorage(): Promise<SubsystemCheck> {
  const start = Date.now();
  try {
    const res = await (storage as unknown as { healthCheck?: () => Promise<{ ok: boolean; message?: string }> }).healthCheck?.();
    return {
      ok: res?.ok ?? true,
      latencyMs: Date.now() - start,
      ...(res?.message ? { message: res.message } : {}),
    };
  } catch (err: unknown) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function checkSecrets(): Promise<SubsystemCheck> {
  const start = Date.now();
  try {
    const sp = createSecretProvider();
    const res = sp.healthCheck ? await sp.healthCheck() : { ok: true };
    return {
      ok: res.ok,
      latencyMs: Date.now() - start,
      ...(res.message ? { message: res.message } : {}),
    };
  } catch (err: unknown) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function checkBullQueues(): Promise<SubsystemCheck> {
  try {
    // Approximate queue depth by reading the BullMQ key set
    const keys = await redis.keys("bull:*:wait");
    const sizes = await Promise.all(keys.map((k) => redis.llen(k)));
    const total = sizes.reduce((a, b) => a + b, 0);
    return {
      ok: true,
      extra: { totalQueued: total, queueCount: keys.length },
    };
  } catch (err: unknown) {
    return { ok: false, message: err instanceof Error ? err.message : String(err) };
  }
}

async function checkPgStats(): Promise<SubsystemCheck> {
  try {
    const rows = (await prismaUnscoped.$queryRawUnsafe(
      `SELECT count(*)::int AS active_count FROM pg_stat_activity WHERE state='active'`,
    )) as { active_count: number }[];
    return { ok: true, extra: { activeConnections: rows[0]?.active_count ?? 0 } };
  } catch {
    return { ok: false };
  }
}

export const GET = withApiErrors(async (_req: NextRequest) => {
  const session = await getSessionFromCookie();
  if (!session) throw new ForbiddenError("Authentication required");

  const [db, redisChk, storageChk, secretsChk, queues, pg] = await Promise.all([
    checkDatabase(),
    checkRedis(),
    checkStorage(),
    checkSecrets(),
    checkBullQueues(),
    checkPgStats(),
  ]);

  const allOk = db.ok && redisChk.ok && storageChk.ok && secretsChk.ok;

  return NextResponse.json(
    {
      status: allOk ? "ok" : "degraded",
      version: process.env.npm_package_version ?? "0.1.0",
      deployMode: process.env.DEPLOY_MODE ?? "self_host",
      uptimeSeconds: Math.round(process.uptime()),
      nodeVersion: process.version,
      checks: {
        db,
        redis: redisChk,
        storage: storageChk,
        secrets: secretsChk,
        queues,
        pgStats: pg,
      },
    },
    { status: allOk ? 200 : 503 },
  );
});
