import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { importMasterJson, NotFoundError } from "@marquee/core";
import { prisma, recordAudit, tenantTransaction } from "@marquee/db";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";

interface RouteContext { params: Promise<{ id: string }> }

const Body = z.object({
  json: z.string().min(2).max(2_000_000),
  truncateToLimits: z.boolean().default(true),
  onlyNewLocales: z.boolean().default(false),
  dryRun: z.boolean().default(false),
});

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");

  const { id } = await context.params;
  const body = Body.parse(await req.json());

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");

    const existing = await prisma.appLocalization.findMany({
      where: { appId: id },
      select: { locale: true },
    });

    const result = importMasterJson({
      json: body.json,
      platform: app.platform,
      truncateToLimits: body.truncateToLimits,
      onlyNewLocales: body.onlyNewLocales,
      existingLocales: existing.map((e) => e.locale),
    });

    if (body.dryRun) {
      return NextResponse.json({ ok: true, dryRun: true, summary: result });
    }

    // Apply actions in a single atomic, tenant-scoped transaction.
    await tenantTransaction(async (tx) => {
      for (const a of result.actions) {
        await tx.appLocalization.upsert({
          where: { appId_locale: { appId: id, locale: a.canonicalLocale } },
          create: {
            appId: id,
            tenantId: app.tenantId,
            locale: a.canonicalLocale,
            ...a.fields,
            dirty: true,
          },
          update: {
            ...a.fields,
            dirty: true,
          },
        });
      }
      await tx.app.update({ where: { id }, data: { dirty: true } });
    });

    await recordAudit({
      action: "metadata.import-master-json",
      target: `app:${id}`,
      appId: id,
      outcome: result.failed.length === 0 ? "SUCCESS" : "PARTIAL",
      diff: {
        parsed: result.parsedLocales,
        created: result.created.length,
        matched: result.matched.length,
        failed: result.failed.length,
        truncated: result.truncated.length,
        unsupportedGooglePlay: result.unsupportedGooglePlay.length,
      },
    });

    return NextResponse.json({ ok: true, summary: result });
  });
});
