import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { Locale } from "@marquee/api-contracts";
import { prisma, recordAudit } from "@marquee/db";
import { NotFoundError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";

interface RouteContext {
  params: Promise<{ id: string; locale: string }>;
}

const PatchLocale = z.object({
  name: z.string().max(50).nullable().optional(),
  subtitle: z.string().max(30).nullable().optional(),
  description: z.string().max(4000).nullable().optional(),
  keywords: z.string().max(100).nullable().optional(),
  whatsNew: z.string().max(4000).nullable().optional(),
  promotionalText: z.string().max(170).nullable().optional(),
  marketingUrl: z.string().url().max(255).nullable().optional(),
  supportUrl: z.string().url().max(255).nullable().optional(),
  privacyPolicyUrl: z.string().url().max(255).nullable().optional(),
  shortDescription: z.string().max(80).nullable().optional(),
  videoUrl: z.string().url().max(255).nullable().optional(),
});

export const PATCH = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id, locale } = await context.params;
  Locale.parse(locale);

  const body = PatchLocale.parse(await req.json());

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({ where: { id } });
    if (!app) throw new NotFoundError("App not found");

    const upserted = await prisma.appLocalization.upsert({
      where: { appId_locale: { appId: id, locale } },
      create: {
        appId: id,
        tenantId: ctx.tenant!.id,
        locale,
        ...body,
        dirty: true,
      },
      update: { ...body, dirty: true },
    });

    // mark app dirty=true (denormalised flag for sidebar counters)
    await prisma.app.update({ where: { id }, data: { dirty: true } });

    await recordAudit({
      action: "metadata.edit",
      target: `app:${id}:locale:${locale}`,
      appId: id,
      outcome: "SUCCESS",
      diff: { locale, changedFields: Object.keys(body) },
    });

    return NextResponse.json({ id: upserted.id, dirty: true });
  });
});
