import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Platform, Uuid } from "@marquee/api-contracts";
import { ValidationError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { buildAppleStack } from "@/lib/adapters";

const DiscoverRequest = z.object({ credentialId: Uuid, platform: Platform });

export const POST = withApiErrors(async (req: NextRequest) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "MAINTAINER");
  void ctx;

  const body = DiscoverRequest.parse(await req.json());

  return withTenantContext(async () => {
    if (body.platform !== "IOS") {
      // Google Play has no public "list all apps" endpoint — the caller must
      // create the app manually with its package name. We respond with an
      // empty list so the UI flow can render a manual-entry form.
      throw new ValidationError(
        "Google Play does not expose a list-apps endpoint. Enter the package name manually.",
      );
    }
    const stack = await buildAppleStack(body.credentialId);
    const apps = await stack.apps.listApps();
    return NextResponse.json({ apps });
  });
});
