/**
 * Public status endpoint — no auth. Designed for synthetic monitors and
 * the /status page. Only exposes high-level subsystem booleans and the
 * SLO targets; no internal latency numbers or queue depths.
 */
import { NextResponse } from "next/server";
import { prismaUnscoped } from "@marquee/db";
import { redis } from "@marquee/cache";
import { SLO_TARGETS } from "@marquee/observability/slo";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET(): Promise<NextResponse> {
  const [dbOk, redisOk] = await Promise.allSettled([
    prismaUnscoped.$queryRaw`SELECT 1`,
    redis.ping(),
  ]);

  const components = [
    { id: "api", name: "API", status: "operational" },
    {
      id: "database",
      name: "Database",
      status: dbOk.status === "fulfilled" ? "operational" : "outage",
    },
    {
      id: "queue",
      name: "Queue / Worker",
      status: redisOk.status === "fulfilled" ? "operational" : "outage",
    },
    { id: "apple", name: "Apple App Store Connect", status: "operational" },
    { id: "google", name: "Google Play Console", status: "operational" },
  ];
  const overall = components.some((c) => c.status === "outage")
    ? "outage"
    : components.some((c) => c.status === "degraded")
      ? "degraded"
      : "operational";

  return NextResponse.json({
    status: overall,
    components,
    slo: Object.values(SLO_TARGETS),
    generatedAt: new Date().toISOString(),
  });
}
