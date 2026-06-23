import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { NotFoundError, ValidationError } from "@marquee/core";
import { prisma, recordAudit } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { requireRole, requireTenant, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { buildGoogleStack } from "@/lib/adapters";

interface RouteContext { params: Promise<{ id: string; trackName: string }> }

const TrackName = z.enum(["internal", "alpha", "beta", "production"]);
const ReleaseStatus = z.enum(["draft", "inProgress", "halted", "completed"]);
const Body = z.object({
  versionCodes: z.array(z.number().int().positive()).min(1).max(50),
  status: ReleaseStatus.default("completed"),
  userFraction: z.number().min(0).max(1).optional(),
  releaseNotes: z.array(z.object({ language: z.string(), text: z.string().max(500) })).optional(),
});

export const PUT = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "MAINTAINER");
  const { id, trackName } = await context.params;
  const parsedTrack = TrackName.parse(trackName);
  const body = Body.parse(await req.json());

  if (body.status === "inProgress" && body.userFraction === undefined) {
    throw new ValidationError("userFraction is required when status=inProgress");
  }

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");
    if (app.platform !== "ANDROID") {
      throw new ValidationError("Track management is Android-only");
    }

    const stack = await buildGoogleStack(app.credentialId);
    const commit = await stack.tracks.assignBundle({
      packageName: app.bundleId,
      trackName: parsedTrack,
      versionCodes: body.versionCodes,
      status: body.status,
      ...(body.userFraction !== undefined ? { userFraction: body.userFraction } : {}),
      ...(body.releaseNotes ? { releaseNotes: body.releaseNotes } : {}),
    });

    await recordAudit({
      action: "build.assign-track",
      target: `app:${id}`,
      appId: id,
      outcome: commit.ok ? "SUCCESS" : "FAILURE",
      diff: {
        track: parsedTrack,
        versionCodes: body.versionCodes,
        status: body.status,
        userFraction: body.userFraction,
        strategy: commit.strategy,
      },
    });

    return NextResponse.json({
      ok: commit.ok,
      strategy: commit.strategy,
      message: commit.message,
    });
  });
});
