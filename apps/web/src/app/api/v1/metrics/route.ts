/**
 * Prometheus scrape endpoint. Default exposure is INTERNAL — protected by a
 * bearer token from `METRICS_BEARER_TOKEN` env. If the env is unset, the
 * endpoint refuses to serve to avoid leaking host metrics to the public.
 *
 * In Kubernetes / nginx, restrict this path to the scrape network by
 * other means and consider it complementary, not sole, protection.
 */
import { type NextRequest, NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";
import { metricsHandler } from "@marquee/observability";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

function tokenMatches(provided: string, required: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(required);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function GET(req: NextRequest): Promise<NextResponse> {
  const required = process.env.METRICS_BEARER_TOKEN;
  if (!required || required.length < 16) {
    return new NextResponse(
      "Metrics endpoint disabled (set METRICS_BEARER_TOKEN to a 16+ char secret to enable)",
      { status: 503 },
    );
  }
  const header = req.headers.get("authorization") ?? "";
  if (!header.startsWith("Bearer ") || !tokenMatches(header.slice("Bearer ".length), required)) {
    return new NextResponse("Unauthorized", { status: 401 });
  }
  const { contentType, body } = await metricsHandler();
  return new NextResponse(body, {
    status: 200,
    headers: { "content-type": contentType },
  });
}
