/**
 * POST /api/v1/apps/[id]/metadata/[locale]/ai-keywords
 *
 * Generate fresh keyword recommendations for ONE locale's keywords
 * field. Returns categorized candidates the user can add with one
 * click — CORE / LONG_TAIL / COMPETITOR_BORROW / SYNONYM / BRAND.
 *
 * Locale-aware in two ways:
 *   1. Context comes from THIS locale's own metadata (title, subtitle,
 *      description, keywords) — not the primary locale's — so the AI
 *      sees the actual copy the user is iterating on.
 *   2. Suggestions come back in the locale's NATIVE LANGUAGE (the
 *      system prompt enforces transliteration for non-English locales).
 *
 * Excludes tokens already in the keywords field and keywords already
 * being tracked for this storefront, so the user gets only NEW ideas.
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@marquee/db";
import { buildKeywordSuggestTask } from "@marquee/aso";
import { NotFoundError, ValidationError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { loadAiOrchestrator } from "@/lib/aiOrchestrator";
import { localeMeta } from "@/lib/localeMeta";
import { deriveTerritory, parseKeywordsField } from "@/lib/keywordsFromMetadata";
import { assertAiRateLimit } from "@/lib/rateLimitWrap";

interface RouteContext {
  params: Promise<{ id: string; locale: string }>;
}

const Body = z.object({
  count: z.number().int().min(5).max(25).default(12),
});

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id, locale } = await context.params;
  await assertAiRateLimit(`${ctx.tenantContext.tenantId}:${id}:ai-keywords`);
  const body = Body.parse(await req.json().catch(() => ({})));

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({
      where: { id },
      select: {
        id: true,
        appName: true,
        platform: true,
        primaryLocale: true,
        bundleId: true,
      },
    });
    if (!app) throw new NotFoundError("App not found");

    const localization = await prisma.appLocalization.findUnique({
      where: { appId_locale: { appId: id, locale } },
    });
    if (!localization) {
      throw new ValidationError(
        `No localization yet for ${locale} — open the metadata workbench to populate it first.`,
      );
    }

    const territory = deriveTerritory(locale);
    // Build the exclusion set: tokens already in this locale's
    // keywords field + every keyword already tracked for this
    // storefront (so we don't get duplicates of either).
    const inField = parseKeywordsField(localization.keywords).map((t) => t.toLowerCase());
    // Pull the top 80 tracked rows with their latest KeywordSignal so the
    // AI can rank suggestions against real Astro / Apple signals.
    const trackedRows = await prisma.trackedKeyword.findMany({
      where: { appId: id, territory },
      select: {
        keyword: true,
        signals: {
          orderBy: { date: "desc" },
          take: 1,
          select: {
            score: true,
            appStoreRank: true,
            bucket: true,
            volume: true,
            maxVolume: true,
            difficulty: true,
            maxReachChance: true,
          },
        },
      },
      take: 300,
    });
    const excludeSet = new Set<string>([
      ...inField,
      ...trackedRows.map((k) => k.keyword.toLowerCase()),
    ]);
    // Build the performance context — top 30 rows by score for the AI
    // to anchor its recommendations against.
    const performanceContext = trackedRows
      .map((row) => {
        const sig = row.signals[0];
        return {
          keyword: row.keyword,
          score: sig?.score != null ? Number(sig.score) : null,
          rank: sig?.appStoreRank ?? null,
          bucket: sig?.bucket ?? null,
          volume: sig?.volume ?? null,
          maxVolume: sig?.maxVolume ?? null,
          difficulty: sig?.difficulty ?? null,
          maxReachChance: sig?.maxReachChance ?? null,
        };
      })
      .sort((a, b) => (b.score ?? 0) - (a.score ?? 0))
      .slice(0, 30);

    const { orchestrator } = await loadAiOrchestrator(ctx.tenant!.id);
    const meta = localeMeta(locale);
    const shortDescription = localization.subtitle ?? localization.promotionalText ?? null;
    const task = buildKeywordSuggestTask({
      appName: app.appName,
      // Use the locale's CANONICAL code so the model treats it as
      // primary for the run — that pushes it to answer in the right
      // language without us having to invent prompt overrides.
      primaryLocale: locale,
      territories: [territory],
      primaryGenre: null,
      shortDescription,
      longDescription: localization.description,
      // Feed in the exclusion set so the model doesn't propose tokens
      // the user already has.
      existingKeywords: [...excludeSet].slice(0, 200),
      // Real Astro / Apple performance for the top tracked terms so the
      // AI ranks suggestions like a professional ASO consultant.
      performanceContext,
      count: body.count,
    });

    // The keyword.suggest prompt is locale-agnostic by default. Append
    // a sharp instruction so the model answers in the right language
    // even when the primary is a non-English locale (the prompt was
    // originally written assuming English).
    const localeNote = `\n\nIMPORTANT: every suggestion MUST be written in ${meta.name} (locale ${locale}). Transliterate brand-borrowed terms correctly. No English in non-English locales.`;
    const localePrompt: typeof task = {
      ...task,
      userPrompt: task.userPrompt + localeNote,
    };

    const result = await orchestrator.run(localePrompt);
    if (!result.ok) {
      throw new ValidationError(
        `AI keyword recommendation failed (${result.code}): ${result.message}`,
        { code: "AI_FAILED", provider: result.provider, retriable: result.retriable },
      );
    }

    // Drop any suggestions that ended up in the exclusion set anyway
    // (the model occasionally ignores instructions).
    const filtered = result.output.suggestions.filter(
      (s) => !excludeSet.has(s.keyword.toLowerCase()),
    );

    const payload = {
      locale,
      territory,
      languageName: meta.name,
      suggestions: filtered,
      notes: result.output.notes ?? null,
      provider: result.provider,
      model: result.model,
      latencyMs: result.latencyMs,
      usage: result.usage,
    };

    // Persist so the panel survives a refresh until the user clicks
    // Regenerate. One row per (app, locale); the next call upserts
    // over the existing payload. RLS scopes by tenantId. Round-trip
    // through JSON.parse(JSON.stringify(...)) so Prisma's `Json` column
    // accepts the value — the AI orchestrator's `AiUsageMeter` shape is
    // structurally a plain object but TS's `InputJsonValue` union can't
    // narrow that without the cast.
    const serialisedPayload = JSON.parse(JSON.stringify(payload)) as unknown;
    await prisma.aiKeywordSuggestion.upsert({
      where: { appId_locale: { appId: id, locale } },
      create: {
        tenantId: ctx.tenant!.id,
        appId: id,
        locale,
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        payload: serialisedPayload as any,
      },
      update: {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        payload: serialisedPayload as any,
      },
    });

    return NextResponse.json({ ...payload, generatedAt: new Date().toISOString() });
  });
});
