import { NextResponse, type NextRequest } from "next/server";
import {
  DeployRequest,
  requiredConnections,
  type RequiredConnection,
} from "@marquee/api-contracts";
import { prisma, recordAudit } from "@marquee/db";
import { enqueue } from "@marquee/jobs";
import { ConflictError, NotFoundError, ValidationError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";

export const dynamic = "force-dynamic";

interface RouteContext {
  params: Promise<{ id: string }>;
}

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id: appId } = await context.params;
  const body = DeployRequest.parse(await req.json());
  // TestFlight was merged into App Store (both upload to App Store Connect) — a
  // single canonical write path. The enum keeps APPLE_TESTFLIGHT only for legacy
  // Build rows.
  if (body.target === "APPLE_TESTFLIGHT") body.target = "APPLE_APP_STORE";

  return withTenantContext(async () => {
    const app = await prisma.app.findFirst({ where: { id: appId } });
    if (!app) throw new NotFoundError("App not found");
    if (app.platform !== body.platform) {
      throw new ValidationError(
        `This app is ${app.platform}; cannot deploy a ${body.platform} build.`,
      );
    }

    // Verify every required connection is present (no-code guardrail).
    // A local build folder satisfies the source requirement (no Git needed).
    const cfg = await prisma.appBuildConfig.findUnique({ where: { appId } });
    const hasLocalSource = Boolean(cfg?.localPath);
    const required = requiredConnections(body.platform, body.target).filter(
      (r) => !(r === "GIT" && hasLocalSource),
    );
    const missing = await findMissingConnections(appId, required);
    if (missing.length > 0) {
      throw new ConflictError(
        `Connect the following before deploying: ${missing.join(", ")}.`,
      );
    }

    // ── Versioning ──────────────────────────────────────────────────────
    // The version + build number come from what the user typed in the launcher,
    // else the stored "next" value. When BOTH are absent (first deploy, fields
    // left on "auto") we leave them null — the runner then reads the project's
    // own version (e.g. CFBundleVersion 4 → 5) and advances the stored next
    // itself, so the launcher shows the right number from then on.
    const autoInc = cfg?.autoIncrementBuildNumber ?? true;
    const resolvedVersion = body.versionName ?? cfg?.versionName ?? null;

    // Resolve the build number. An explicit value (user typed it) is used as-is.
    // Otherwise the stored counter is reserved ATOMICALLY (compare-and-swap) so
    // two near-simultaneous deploys (double-click / two tabs) can never ship the
    // same number. null → no counter yet (first deploy); the runner computes it.
    const resolvedBuild =
      body.buildNumber ?? (await reserveStoredBuildNumber(appId, autoInc));

    const build = await prisma.build.create({
      data: {
        tenantId: ctx.tenant!.id,
        appId,
        platform: body.platform,
        target: body.target,
        status: "QUEUED",
        gitRef: body.gitRef ?? "main",
        versionString: resolvedVersion,
        buildNumber: resolvedBuild != null ? String(resolvedBuild) : null,
        // The runner reads these resolved values from config (no recompute when set).
        config: { ...body, versionName: resolvedVersion, buildNumber: resolvedBuild } as never,
        createdById: ctx.user.id,
      },
    });

    // Persist the version, and for an EXPLICIT build number advance the stored
    // counter past it (the reserved path already advanced it atomically above).
    const cfgUpdate: Record<string, unknown> = {};
    if (resolvedVersion != null) cfgUpdate.versionName = resolvedVersion;
    if (body.buildNumber != null) {
      cfgUpdate.nextBuildNumber = autoInc ? body.buildNumber + 1 : body.buildNumber;
    }
    if (Object.keys(cfgUpdate).length > 0) {
      await prisma.appBuildConfig.upsert({
        where: { appId },
        create: { tenantId: ctx.tenant!.id, appId, createdById: ctx.user.id, ...cfgUpdate },
        update: cfgUpdate,
      });
    }

    const { jobId } = await enqueue(
      "build.run",
      {
        tenantId: ctx.tenant!.id,
        userId: ctx.user.id,
        appId,
        buildId: build.id,
        platform: body.platform,
        target: body.target,
        gitRef: body.gitRef,
        releaseNotes: body.releaseNotes,
      },
      { idempotencyKey: build.id, appId },
    );

    await prisma.build.update({ where: { id: build.id }, data: { jobId } });

    await recordAudit({
      action: "build.deploy.start",
      target: `app:${appId}`,
      appId,
      outcome: "SUCCESS",
      diff: { buildId: build.id, target: body.target, platform: body.platform },
    });

    return NextResponse.json({ buildId: build.id, jobId }, { status: 202 });
  });
});

async function findMissingConnections(
  appId: string,
  required: RequiredConnection[],
): Promise<string[]> {
  const missing: string[] = [];
  for (const r of required) {
    if (r === "GIT" || r === "FIREBASE" || r === "ANDROID_KEYSTORE") {
      const conn = await prisma.appConnection.findFirst({ where: { appId, kind: r } });
      if (!conn) missing.push(label(r));
    } else {
      // APPLE / GOOGLE reuse the tenant-wide Credential table.
      const cred = await prisma.credential.findFirst({ where: { kind: r, isActive: true } });
      if (!cred) missing.push(label(r));
    }
  }
  return missing;
}

/**
 * Atomically reserves the next build number from AppBuildConfig.nextBuildNumber
 * via an optimistic compare-and-swap loop, so concurrent deploys each get a
 * distinct number. Returns the reserved number, or null when there is no stored
 * counter yet (first deploy → the runner derives it from the project).
 */
async function reserveStoredBuildNumber(appId: string, autoInc: boolean): Promise<number | null> {
  for (let attempt = 0; attempt < 6; attempt++) {
    const c = await prisma.appBuildConfig.findUnique({
      where: { appId },
      select: { nextBuildNumber: true },
    });
    const current = c?.nextBuildNumber ?? null;
    if (current == null) return null;
    if (!autoInc) return current; // manual mode — fixed number, no increment
    const res = await prisma.appBuildConfig.updateMany({
      where: { appId, nextBuildNumber: current },
      data: { nextBuildNumber: current + 1 },
    });
    if (res.count === 1) return current; // won the CAS — this number is ours
    // Lost the race; another deploy took `current`. Retry with the new value.
  }
  const c = await prisma.appBuildConfig.findUnique({
    where: { appId },
    select: { nextBuildNumber: true },
  });
  return c?.nextBuildNumber ?? null;
}

function label(r: RequiredConnection): string {
  const map: Record<RequiredConnection, string> = {
    GIT: "Git repository",
    APPLE: "App Store Connect key",
    GOOGLE: "Google Play service account",
    FIREBASE: "Firebase",
    ANDROID_KEYSTORE: "Android keystore",
  };
  return map[r];
}
