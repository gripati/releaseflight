import { NextResponse, type NextRequest } from "next/server";
import { Readable } from "node:stream";
import { prisma } from "@marquee/db";
import { storage } from "@marquee/storage";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, withTenantContext } from "@/lib/auth";

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

interface RouteContext {
  params: Promise<{ id: string; buildId: string }>;
}

/**
 * Stream a build artifact (APK/AAB/IPA) to the browser through the SAME-ORIGIN
 * Next server — never a raw `storage.signedGetUrl()`. On self-host the S3/MinIO
 * endpoint (`S3_ENDPOINT=http://minio:9000`) is only reachable inside the docker
 * network, so a presigned URL pointed at it is dead in the browser / Tauri
 * webview. Proxying the bytes here keeps downloads working regardless of the
 * storage backend, and keeps the internal endpoint off the wire (no SSRF/leak).
 *
 * Auth: the build lookup runs under `withTenantContext`, so Postgres RLS
 * (`apply_tenant_isolation` + `apply_app_scope` on `Build`) enforces both tenant
 * isolation and per-member app scope — a member scoped away from this app sees
 * zero rows ⇒ 404. We stream (not buffer) so large artifacts don't sit in RAM.
 */
export const GET = withApiErrors(async (_req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id: appId, buildId } = await context.params;

  return withTenantContext(async () => {
    const build = await prisma.build.findFirst({ where: { id: buildId, appId } });
    if (!build?.artifactStorageKey) throw new NotFoundError("Artifact not available");

    let obj: { body: Readable; contentType: string | undefined; size: number };
    try {
      obj = await storage.getStream(build.artifactStorageKey);
    } catch (err: unknown) {
      const e = err as NodeJS.ErrnoException & { name?: string; $metadata?: { httpStatusCode?: number } };
      if (e.code === "ENOENT" || e.name === "NoSuchKey" || e.$metadata?.httpStatusCode === 404) {
        throw new NotFoundError("Artifact not available");
      }
      throw err;
    }

    const ext = (build.artifactKind ?? "bin").toLowerCase();
    const nameParts = [build.platform.toLowerCase()];
    if (build.versionString) nameParts.push(`v${build.versionString}`);
    if (build.buildNumber) nameParts.push(`b${build.buildNumber}`);
    // Sanitise — versionString/buildNumber are user/git-influenced, so strip
    // anything outside [A-Za-z0-9._-] to keep the Content-Disposition header
    // free of quotes/CRLF (header-injection safe).
    const base = nameParts.join("-").replace(/[^A-Za-z0-9._-]/g, "") || "artifact";
    const filename = `${base}.${ext}`;

    return new NextResponse(Readable.toWeb(obj.body) as unknown as ReadableStream, {
      status: 200,
      headers: {
        "content-type": obj.contentType ?? "application/octet-stream",
        ...(obj.size ? { "content-length": obj.size.toString() } : {}),
        "content-disposition": `attachment; filename="${filename}"`,
        "cache-control": "private, no-store",
      },
    });
  });
});
