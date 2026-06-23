import { NextResponse, type NextRequest } from "next/server";
import { NotFoundError, ValidationError } from "@marquee/core";
import { prisma, recordAudit } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { requireRole, requireTenant, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { buildGoogleStack } from "@/lib/adapters";

interface RouteContext { params: Promise<{ id: string }> }

const MAX_AAB_BYTES = 500 * 1024 * 1024;

export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "MAINTAINER");
  const { id } = await context.params;

  const formData = await req.formData();
  const file = formData.get("file");
  if (!(file instanceof File)) throw new ValidationError("file is required");
  if (file.size > MAX_AAB_BYTES) {
    throw new ValidationError(`Bundle too large (${(file.size / 1024 / 1024).toFixed(1)} MB) — max 500 MB`);
  }
  if (!file.name.toLowerCase().endsWith(".aab")) {
    throw new ValidationError("Only .aab (Android App Bundle) is accepted via the web upload — Apple IPAs go through Xcode / Transporter");
  }

  const fileBuffer = Buffer.from(await file.arrayBuffer());

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");
    if (app.platform !== "ANDROID") {
      throw new ValidationError("AAB upload is Android-only — iOS builds are uploaded via Xcode / Transporter");
    }

    const stack = await buildGoogleStack(app.credentialId);
    const result = await stack.aab.uploadAab({
      packageName: app.bundleId,
      fileBuffer,
    });

    await recordAudit({
      action: "build.upload.aab",
      target: `app:${id}`,
      appId: id,
      outcome: "SUCCESS",
      diff: {
        versionCode: result.versionCode,
        sha256: result.sha256,
        fileName: file.name,
        fileSize: file.size,
      },
    });

    return NextResponse.json({
      ok: true,
      versionCode: result.versionCode,
      sha256: result.sha256,
    });
  });
});
