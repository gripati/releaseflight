/**
 * Per-request observability — runs the handler under a timer that emits
 * the histogram and counter samples. Wires up to `withApiErrors` so the
 * surrounding error catching can still happen.
 */
import type { NextResponse } from "next/server";
import { type NextRequest } from "next/server";
import { observeHttp } from "@marquee/observability";

export function withObservability<TArgs extends unknown[]>(
  route: string,
  handler: (...args: [NextRequest, ...TArgs]) => Promise<NextResponse>,
): (...args: [NextRequest, ...TArgs]) => Promise<NextResponse> {
  return async (req, ...rest) => {
    const start = process.hrtime.bigint();
    try {
      const res = await handler(req, ...rest);
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      observeHttp(req.method, route, res.status, seconds);
      return res;
    } catch (err) {
      const seconds = Number(process.hrtime.bigint() - start) / 1e9;
      observeHttp(req.method, route, 500, seconds);
      throw err;
    }
  };
}
