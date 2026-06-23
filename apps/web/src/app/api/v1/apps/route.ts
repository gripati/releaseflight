import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Locale, Platform, Uuid } from "@marquee/api-contracts";
import { prisma, recordAudit } from "@marquee/db";
import { ValidationError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";

const CreateApp = z.object({
  platform: Platform,
  bundleId: z
    .string()
    .min(3)
    .max(155)
    .regex(
      /^[a-zA-Z][a-zA-Z0-9_]*(\.[a-zA-Z][a-zA-Z0-9_]*)+$/,
      "Bundle id must follow reverse-domain notation (e.g. com.example.app)",
    ),
  appName: z.string().min(1).max(80),
  primaryLocale: Locale.default("en-US"),
  credentialId: Uuid,
  storeAppId: z.string().optional(),
});

export const GET = withApiErrors(async () => {
  return withTenantContext(async () => {
    const apps = await prisma.app.findMany({
      orderBy: { createdAt: "desc" },
      include: { _count: { select: { localizations: { where: { dirty: true } } } } },
    });
    return NextResponse.json({
      apps: apps.map((a) => ({
        id: a.id,
        platform: a.platform,
        bundleId: a.bundleId,
        storeAppId: a.storeAppId,
        appName: a.appName,
        primaryLocale: a.primaryLocale,
        status: a.status,
        versionString: a.versionString,
        versionId: a.versionId,
        isConnected: a.isConnected,
        dirty: a.dirty,
        dirtyCount: a._count.localizations,
        availableLanguages: a.availableLanguages,
        discoveredScreenshotTypes: a.discoveredScreenshotTypes,
        discoveredPreviewTypes: a.discoveredPreviewTypes,
        lastFetchedAt: a.lastFetchedAt?.toISOString() ?? null,
        lastPushedAt: a.lastPushedAt?.toISOString() ?? null,
        credentialId: a.credentialId,
        createdAt: a.createdAt.toISOString(),
      })),
    });
  });
});

export const POST = withApiErrors(async (req: NextRequest) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "MAINTAINER");

  const body = CreateApp.parse(await req.json());

  return withTenantContext(async () => {
    const cred = await prisma.credential.findUnique({ where: { id: body.credentialId } });
    if (!cred) throw new ValidationError("Credential not found");
    if (body.platform === "IOS" && cred.kind !== "APPLE") {
      throw new ValidationError("iOS apps require an APPLE credential");
    }
    if (body.platform === "ANDROID" && cred.kind === "APPLE") {
      throw new ValidationError("Android apps require a GOOGLE credential");
    }

    const app = await prisma.app.create({
      data: {
        tenantId: ctx.tenant!.id,
        credentialId: body.credentialId,
        platform: body.platform,
        bundleId: body.bundleId,
        storeAppId: body.storeAppId ?? (body.platform === "ANDROID" ? body.bundleId : null),
        appName: body.appName,
        primaryLocale: body.primaryLocale,
        createdById: ctx.user.id,
      },
    });
    await recordAudit({
      action: "app.create",
      target: `app:${app.id}`,
      outcome: "SUCCESS",
      appId: app.id,
      diff: { platform: app.platform, bundleId: app.bundleId, appName: app.appName },
    });
    return NextResponse.json({ id: app.id, appName: app.appName, platform: app.platform }, { status: 201 });
  });
});
