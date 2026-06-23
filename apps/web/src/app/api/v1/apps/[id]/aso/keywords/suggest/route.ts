/**
 * POST /api/v1/apps/[id]/aso/keywords/suggest
 *
 * Runs the keyword.suggest AI task through the tenant's configured
 * chain (primary first, fallbacks on retriable failure) and returns
 * the model's suggestions. Does NOT add them to tracking — the user
 * picks which ones to keep.
 *
 * Body: { count?: number (5–25, default 10), territories?: string[] }
 * Response: { suggestions: KeywordSuggestion[], notes?: string,
 *             provider, model, latencyMs, usage }
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@marquee/db";
import { buildKeywordSuggestTask } from "@marquee/aso";
import { NotFoundError, ValidationError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { loadAiOrchestrator, AiNotConfiguredError } from "@/lib/aiOrchestrator";
import { assertAiRateLimit } from "@/lib/rateLimitWrap";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const SuggestBody = z.object({
  count: z.number().int().min(5).max(25).default(10),
  territories: z
    .array(z.string().length(2).regex(/^[A-Z]{2}$/))
    .max(8)
    .optional(),
});

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id } = await context.params;
  await assertAiRateLimit(`${ctx.tenantContext.tenantId}:${id}:kw-suggest`);
  const body = SuggestBody.parse(await req.json().catch(() => ({})));

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({
      where: { id },
      include: {
        localizations: {
          where: { locale: { startsWith: "" } },
          orderBy: { locale: "asc" },
        },
      },
    });
    if (!app) throw new NotFoundError("App not found");

    const primaryLoc =
      app.localizations.find((l) => l.locale === app.primaryLocale) ?? app.localizations[0];
    if (!primaryLoc) {
      throw new ValidationError(
        "App has no localizations yet — fetch metadata before requesting AI suggestions.",
      );
    }

    const tracked = await prisma.trackedKeyword.findMany({
      where: { appId: id },
      select: { keyword: true },
      orderBy: { keyword: "asc" },
      take: 200,
    });

    const territories = body.territories ?? [
      primaryLoc.locale.split("-")[1] ?? "US",
    ];

    const { orchestrator } = await loadAiOrchestrator(ctx.tenant!.id);
    const task = buildKeywordSuggestTask({
      appName: app.appName,
      primaryLocale: app.primaryLocale,
      territories,
      primaryGenre: null,
      shortDescription: primaryLoc.subtitle ?? primaryLoc.promotionalText ?? null,
      longDescription: primaryLoc.description ?? null,
      existingKeywords: tracked.map((k) => k.keyword),
      count: body.count,
    });

    const result = await orchestrator.run(task);
    if (!result.ok) {
      throw new ValidationError(
        `AI suggestion failed (${result.code}): ${result.message}`,
        { code: "AI_FAILED", provider: result.provider, retriable: result.retriable },
      );
    }

    return NextResponse.json({
      suggestions: result.output.suggestions,
      notes: result.output.notes ?? null,
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      usage: result.usage,
    });
  });
});

// Lazy import for the AiNotConfiguredError check — keep the route file's
// import list small. Errors propagate through withApiErrors which knows
// how to serialise AppError subclasses including our AiNotConfigured.
void AiNotConfiguredError;
