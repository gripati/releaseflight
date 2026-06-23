import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@marquee/db";
import { NotFoundError, ValidationError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireRole, requireTenant, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { buildAppleStack, buildGoogleStack } from "@/lib/adapters";

interface RouteContext { params: Promise<{ id: string }> }

export const dynamic = "force-dynamic";

/** Declares a build's export-compliance encryption status (App Store's #1 submit
 *  gate). Lets the user resolve "Missing Compliance" with one click. */
export const PATCH = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "MAINTAINER");
  const { id } = await context.params;
  const body = z
    .object({ buildId: z.string().min(1), usesNonExemptEncryption: z.boolean() })
    .parse(await req.json());

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");
    if (app.platform !== "IOS") throw new ValidationError("Compliance applies to iOS builds only.");
    const stack = await buildAppleStack(app.credentialId);
    await stack.builds.updateBuildCompliance(body.buildId, body.usesNonExemptEncryption);
    return NextResponse.json({ ok: true });
  });
});

export const GET = withApiErrors(async (_req: NextRequest, context: RouteContext) => {
  await requireTenant();
  const { id } = await context.params;

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");

    if (app.platform === "IOS") {
      // Apple's GET /builds?filter[app]= needs the NUMERIC App Store Connect id,
      // never a reverse-DNS bundle id — a bundleId fallback returns an empty
      // list and falsely blocks submit. Require storeAppId.
      if (!app.storeAppId) {
        throw new ValidationError(
          "This app has no App Store Connect id yet — click “Pull from store” to link it, then refresh.",
        );
      }
      const stack = await buildAppleStack(app.credentialId);
      const builds = await stack.builds.listBuilds(app.storeAppId, 50);
      return NextResponse.json({
        platform: "IOS",
        builds: builds.map((b) => ({
          id: b.id,
          version: b.version,
          buildNumber: b.buildNumber,
          uploadedDate: b.uploadedDate,
          state: b.processingState,
          usesNonExemptEncryption: b.usesNonExemptEncryption,
        })),
      });
    }

    const stack = await buildGoogleStack(app.credentialId);
    const bundles = await stack.aab.listBundles(app.bundleId);
    const tracks = await stack.tracks.listTracks(app.bundleId);
    return NextResponse.json({
      platform: "ANDROID",
      bundles: bundles.map((b) => ({
        versionCode: b.versionCode,
        sha256: b.sha256,
        sha1: b.sha1,
      })),
      tracks: tracks.map((t) => ({
        track: t.track,
        releases: t.releases.map((r) => ({
          name: r.name,
          versionCodes: r.versionCodes,
          status: r.status,
          userFraction: r.userFraction,
        })),
      })),
    });
  });
});
