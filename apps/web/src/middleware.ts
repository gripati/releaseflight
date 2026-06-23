import { NextResponse, type NextRequest } from "next/server";
import { buildCsp } from "@/lib/csp";

/**
 * Edge middleware — runs BEFORE every matched request. It:
 *   1. Stamps an `x-request-id` for tracing.
 *   2. Generates a per-request CSP nonce and emits a strict Content-Security-
 *      Policy. The nonce is set on the REQUEST headers (alongside the CSP) so
 *      Next.js applies it to its framework <script> tags, and exposed as
 *      `x-nonce` so server components (app/layout.tsx) can nonce their own
 *      inline scripts. This lets production drop `'unsafe-inline'` from
 *      script-src — the one remaining XSS-containment gap from the audit.
 *
 * Real auth + tenant resolution stays in route handlers / server components
 * (Prisma isn't edge-compatible); RLS at the DB layer is the real backstop.
 */
export function middleware(req: NextRequest): NextResponse {
  const requestId = req.headers.get("x-request-id") ?? crypto.randomUUID();
  const nonce = btoa(crypto.randomUUID());
  const isProd = process.env.NODE_ENV === "production";
  // Served over HTTPS? Behind a TLS-terminating proxy the upstream scheme is in
  // x-forwarded-proto; otherwise fall back to the scheme Next sees. A self-host
  // box on http://localhost has neither → secure=false → no upgrade-insecure-
  // requests (which would otherwise break all http subresources). See csp.ts.
  const proto =
    req.headers.get("x-forwarded-proto")?.split(",")[0]?.trim() ||
    req.nextUrl.protocol.replace(/:$/, "");
  const secure = proto === "https";
  const csp = buildCsp({ nonce, isProd, secure });

  const requestHeaders = new Headers(req.headers);
  requestHeaders.set("x-request-id", requestId);
  requestHeaders.set("x-nonce", nonce);
  // Next.js reads the nonce from the CSP it sees on the request headers.
  requestHeaders.set("content-security-policy", csp);

  const res = NextResponse.next({ request: { headers: requestHeaders } });
  res.headers.set("x-request-id", requestId);
  res.headers.set("content-security-policy", csp);
  return res;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
