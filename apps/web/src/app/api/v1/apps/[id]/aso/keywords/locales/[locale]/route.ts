/**
 * PUT /api/v1/apps/[id]/aso/keywords/locales/[locale]
 *
 * Atomically update the keywords field of one locale. Used by the
 * inline chip add/remove UI. The new value is comma-joined from the
 * client's token list (the UI handles edits as tokens, not raw text).
 *
 * Side-effects:
 *   • Marks the AppLocalization row dirty so the user remembers to
 *     push.
 *   • Auto-imports any new tokens as TrackedKeyword (source=
 *     APP_METADATA) so the keyword borsası catches them immediately.
 *
 * Body: { tokens: string[] }
 *
 * Note: this updates LOCAL state only — it does NOT push to Apple.
 * The user pushes from the Metadata tab.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma, recordAudit } from "@marquee/db";
import { NotFoundError, ValidationError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { syncKeywordsFromMetadata, parseKeywordsField } from "@/lib/keywordsFromMetadata";

interface RouteContext {
  params: Promise<{ id: string; locale: string }>;
}

const Body = z.object({
  tokens: z.array(z.string().trim().min(1).max(80)).max(40),
});

const MAX_CHARS = 100;

export const PUT = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id, locale } = await context.params;
  const body = Body.parse(await req.json());

  // Dedupe + clamp.
  const unique = Array.from(new Set(body.tokens.map((t) => t.trim()).filter((t) => t.length > 0)));
  const joined = unique.join(",");
  if (joined.length > MAX_CHARS) {
    throw new ValidationError(
      `Keywords field would be ${joined.length.toString()} chars (max ${MAX_CHARS.toString()}). Remove some tokens.`,
    );
  }

  return withTenantContext(async () => {
    const loc = await prisma.appLocalization.findUnique({
      where: { appId_locale: { appId: id, locale } },
    });
    if (!loc) throw new NotFoundError(`Locale ${locale} not found on app`);

    const before = parseKeywordsField(loc.keywords);
    await prisma.appLocalization.update({
      where: { appId_locale: { appId: id, locale } },
      data: { keywords: joined, dirty: true },
    });

    const after = parseKeywordsField(joined);
    const beforeLower = new Set(before.map((t) => t.toLowerCase()));
    const afterLower = new Set(after.map((t) => t.toLowerCase()));
    const added = after.filter((t) => !beforeLower.has(t.toLowerCase()));
    const removed = before.filter((t) => !afterLower.has(t.toLowerCase()));

    // Auto-track newly added tokens.
    const importResult = await syncKeywordsFromMetadata({
      tenantId: ctx.tenant!.id,
      appId: id,
      userId: ctx.user.id,
      locales: [locale],
    });

    await recordAudit({
      action: "aso.keyword.field.update",
      target: `appLocalization:${id}:${locale}`,
      appId: id,
      outcome: "SUCCESS",
      diff: {
        locale,
        before,
        after,
        added,
        removed,
        autoTracked: importResult.importedCount,
      },
    });

    return NextResponse.json({
      ok: true,
      locale,
      tokens: after,
      chars: joined.length,
      added,
      removed,
      autoTracked: importResult.importedCount,
      dirty: true,
    });
  });
});
