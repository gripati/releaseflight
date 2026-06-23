import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { NotFoundError, ValidationError, ConflictError } from "@marquee/core";
import { prisma, recordAudit } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { requireRole, requireTenant, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { buildAppleStack } from "@/lib/adapters";

interface RouteContext {
  params: Promise<{ id: string }>;
}

// A selected build is REQUIRED — Apple rejects a buildless version, and Unity
// hard-requires one too.
const Body = z.object({
  buildId: z.string().min(1),
});

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "MAINTAINER");
  const { id } = await context.params;
  const body = Body.parse(await req.json().catch(() => ({})));

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");
    if (app.platform !== "IOS") {
      throw new ValidationError("Apple submission flow is iOS-only — Android uses track assignment");
    }
    if (!app.storeAppId) {
      throw new ValidationError("App has no App Store Connect id — click “Pull from store” first.");
    }

    const stack = await buildAppleStack(app.credentialId);

    // Re-validate against a live EDITABLE version (the stored versionId is
    // LIVE-first and often read-only). Attach + submit THAT version.
    const editable = await stack.apps.getOrCreateEditableVersion(app.storeAppId);
    if (editable.id !== app.versionId) {
      await prisma.app
        .update({ where: { id }, data: { versionId: editable.id } })
        .catch(() => undefined);
    }

    await stack.builds.attachBuildToVersion(editable.id, body.buildId);

    let result;
    try {
      result = await stack.builds.submitForReview(app.storeAppId, editable.id, "IOS");
    } catch (err: unknown) {
      await recordAudit({
        action: "submission.review",
        target: `app:${id}`,
        appId: id,
        outcome: "FAILURE",
        errorCode: err instanceof Error ? err.name : "UNKNOWN",
        diff: { error: err instanceof Error ? err.message : String(err) },
      });
      if (err instanceof ConflictError) {
        throw new ValidationError(
          "There's already an open submission for this app in App Store Connect. " +
            "Cancel it (the “Cancel open submission” action, or in App Store Connect), then retry.",
        );
      }
      throw err;
    }

    await recordAudit({
      action: "submission.review",
      target: `app:${id}`,
      appId: id,
      outcome: "SUCCESS",
      diff: { submissionId: result.submissionId, itemId: result.itemId, buildId: body.buildId },
    });

    return NextResponse.json({
      ok: true,
      submissionId: result.submissionId,
      itemId: result.itemId,
    });
  });
});

/** Cancels an open (not-yet-reviewed) submission so the user can retry. */
export const DELETE = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "MAINTAINER");
  const { id } = await context.params;

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");
    if (app.platform !== "IOS" || !app.storeAppId) {
      throw new ValidationError("No App Store submission to cancel.");
    }
    const stack = await buildAppleStack(app.credentialId);
    const canceled = await stack.builds.cancelSubmission(app.storeAppId, "IOS");
    await recordAudit({
      action: "submission.cancel",
      target: `app:${id}`,
      appId: id,
      outcome: canceled ? "SUCCESS" : "SUCCESS",
      diff: { canceled },
    });
    return NextResponse.json({ ok: true, canceled });
  });
});
