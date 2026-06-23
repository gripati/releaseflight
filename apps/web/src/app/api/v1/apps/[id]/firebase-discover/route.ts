import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { FirebaseManagement, GoogleAuth, NotFoundError, ValidationError } from "@marquee/core";
import { prisma } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const Body = z.object({ serviceAccountJson: z.string().min(40) });

/**
 * Given a Firebase service-account JSON, lists the project's iOS/Android apps
 * via the Firebase Management API and suggests the App ID matching this app's
 * bundle id — so the Deploy → Firebase wizard can auto-fill the App IDs.
 */
export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id: appId } = await context.params;
  const { serviceAccountJson } = Body.parse(await req.json());

  return withTenantContext(async () => {
    const app = await prisma.app.findFirst({ where: { id: appId } });
    if (!app) throw new NotFoundError("App not found");

    let parsed: { client_email?: string; private_key?: string; project_id?: string };
    try {
      parsed = JSON.parse(serviceAccountJson) as typeof parsed;
    } catch {
      throw new ValidationError("Invalid service-account JSON");
    }
    if (!parsed.client_email || !parsed.private_key || !parsed.project_id) {
      throw new ValidationError(
        "Service-account JSON is missing client_email / private_key / project_id",
      );
    }

    const mgmt = new FirebaseManagement(new GoogleAuth(), {
      id: "firebase-discover",
      clientEmail: parsed.client_email,
      privateKeyPem: parsed.private_key,
      projectId: parsed.project_id,
    });
    const { iosApps, androidApps } = await mgmt.listApps(parsed.project_id);

    // Auto-fill priority, per platform:
    //   "exact"     — a Firebase app's bundle id / package name matches this app
    //   "only"      — no exact match, but the project has exactly ONE such app,
    //                 so it's unambiguous and safe to fill
    //   "ambiguous" — several apps and none match → leave null, let the user pick
    //                 from the returned list (never silently save app[0])
    //   "none"      — the project has no app of that platform
    interface Managed {
      appId: string;
      bundleId?: string;
      packageName?: string;
    }
    const pick = (
      apps: Managed[],
      matches: (a: Managed) => boolean,
    ): { appId: string | null; match: "exact" | "only" | "ambiguous" | "none" } => {
      const exact = apps.find(matches);
      if (exact) return { appId: exact.appId, match: "exact" };
      if (apps.length === 1) return { appId: apps[0]!.appId, match: "only" };
      if (apps.length > 1) return { appId: null, match: "ambiguous" };
      return { appId: null, match: "none" };
    };

    const ios = pick(iosApps, (a) => Boolean(app.bundleId) && a.bundleId === app.bundleId);
    const android = pick(
      androidApps,
      (a) => Boolean(app.bundleId) && a.packageName === app.bundleId,
    );

    return NextResponse.json({
      projectId: parsed.project_id,
      iosApps,
      androidApps,
      suggestedIosAppId: ios.appId,
      suggestedAndroidAppId: android.appId,
      iosMatch: ios.match,
      androidMatch: android.match,
    });
  });
});
