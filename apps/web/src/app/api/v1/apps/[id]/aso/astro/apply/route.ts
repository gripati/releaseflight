/**
 * POST /api/v1/apps/[id]/aso/astro/apply
 *
 * Apply user-selected Astro autopilot proposals to the keywords field
 * of each locale. Two modes:
 *
 *   • mode: "auto"      → applies only DECAY_AUTO proposals.
 *   • mode: "selected"  → applies the exact (weak, strong) pairs the
 *                          caller passes in (typically built from a
 *                          recommend response the user reviewed).
 *
 * Atomic per-locale: each locale is updated in one statement. We:
 *
 *   1. Read the current keywords field.
 *   2. For each (weakKeyword, strongKeyword) pair, replace weakKeyword's
 *      token in the comma-separated field (case-insensitive, exact
 *      token match). When weakKeyword is null, append strongKeyword
 *      instead (subject to the 100-char cap).
 *   3. Drop excess characters from the END if the result exceeds 100
 *      chars — the new strong tokens are at the front so high-value
 *      tokens are preserved.
 *   4. Write the new field + mark `dirty: true` so the next push picks
 *      it up.
 *   5. Add new tracked rows for any added strong keywords so the
 *      keyword refresh job starts collecting signals for them.
 *
 * Body:
 *   {
 *     mode: "auto" | "selected",
 *     // for mode=auto:
 *     locales?: string[],
 *     // for mode=selected:
 *     swapsByLocale?: [{
 *       locale: string,
 *       pairs: [{ weakKeyword: string | null, strongKeyword: string }]
 *     }]
 *   }
 *
 * Response:
 *   {
 *     perLocale: [{
 *       locale, territory,
 *       before, after,
 *       applied: number,        // pairs actually applied
 *       skippedReason?: string  // why a pair was skipped (e.g. weak not in field)
 *     }],
 *     totalApplied: number,
 *     newTrackedKeywords: number  // how many tracked rows we created
 *   }
 */
import { NextResponse, type NextRequest } from "next/server";
import { z } from "zod";
import { prisma } from "@marquee/db";
import type { AutopilotApp, LocalTrackedKeyword } from "@marquee/aso";
import { NotFoundError, ValidationError } from "@marquee/core";
import { withApiErrors } from "@/lib/responses";
import { requireTenant, requireRole, withTenantContext } from "@/lib/auth";
import { assertCsrf, CSRF_HEADER } from "@/lib/csrf";
import { loadAstroAutopilot } from "@/lib/astroAutopilot";
import { deriveTerritory, parseKeywordsField } from "@/lib/keywordsFromMetadata";
import { applyAstroSwaps } from "@/lib/applyAstroSwaps";

interface RouteContext {
  params: Promise<{ id: string }>;
}

const PairSchema = z.object({
  weakKeyword: z.string().min(0).max(80).nullable(),
  strongKeyword: z.string().min(1).max(80),
});

const Body = z.discriminatedUnion("mode", [
  z.object({
    mode: z.literal("auto"),
    locales: z.array(z.string().min(2).max(20)).max(60).optional(),
    maxAutoSwapsPerLocale: z.number().int().min(0).max(15).default(6),
  }),
  z.object({
    mode: z.literal("selected"),
    swapsByLocale: z
      .array(
        z.object({
          locale: z.string().min(2).max(20),
          pairs: z.array(PairSchema).max(30),
        }),
      )
      .max(60),
  }),
]);

export const POST = withApiErrors(async (req: NextRequest, context: RouteContext) => {
  await assertCsrf(req.headers.get(CSRF_HEADER));
  const ctx = await requireTenant();
  requireRole(ctx.role, "EDITOR");
  const { id } = await context.params;
  const body = Body.parse(await req.json().catch(() => ({})));

  return withTenantContext(async () => {
    const app = await prisma.app.findUnique({
      where: { id },
      select: {
        id: true,
        appName: true,
        bundleId: true,
        platform: true,
        storeAppId: true,
      },
    });
    if (!app) throw new NotFoundError("App not found");
    if (app.platform !== "IOS") {
      throw new ValidationError("Astro autopilot only supports iOS apps.");
    }

    // Resolve which (locale, pairs[]) batches to run.
    type Pair = z.infer<typeof PairSchema>;
    let batches: { locale: string; pairs: Pair[] }[];

    if (body.mode === "selected") {
      batches = body.swapsByLocale;
    } else {
      // Auto mode — recompute fresh DECAY_AUTO proposals so the user
      // never auto-applies stale recommendations.
      const loaded = await loadAstroAutopilot(ctx.tenant!.id);

      const locFilter: { appId: string; locale?: { in: string[] } } = { appId: id };
      if (body.locales && body.locales.length > 0) {
        locFilter.locale = { in: body.locales };
      }
      const [localizations, trackedRows] = await Promise.all([
        prisma.appLocalization.findMany({
          where: locFilter,
          select: { locale: true, keywords: true },
        }),
        prisma.trackedKeyword.findMany({
          where: { appId: id, status: "ACTIVE" },
          select: {
            id: true,
            keyword: true,
            territory: true,
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
          take: 3000,
        }),
      ]);

      const autopilotApp: AutopilotApp = {
        id: app.id,
        appName: app.appName,
        bundleId: app.bundleId,
        store: "ios",
        storeAppId: app.storeAppId,
      };

      batches = [];
      for (const loc of localizations) {
        const territory = deriveTerritory(loc.locale);
        const tokens = parseKeywordsField(loc.keywords);
        const local: LocalTrackedKeyword[] = trackedRows
          .filter((t) => t.territory === territory)
          .map((t) => {
            const sig = t.signals[0];
            return {
              id: t.id,
              keyword: t.keyword,
              territory: t.territory,
              score: sig?.score != null ? Number(sig.score) : null,
              bucket: sig?.bucket ?? null,
              rank: sig?.appStoreRank ?? null,
              inField: tokens.some(
                (tok) => tok.toLowerCase() === t.keyword.toLowerCase(),
              ),
              volume: sig?.volume ?? null,
              difficulty: sig?.difficulty ?? null,
              maxReachChance: sig?.maxReachChance ?? null,
            };
          });

        try {
          const result = await loaded.autopilot.proposeSwaps(autopilotApp, local, {
            territory,
            maxAutoSwaps: body.maxAutoSwapsPerLocale,
          });
          const autoPairs: Pair[] = result.proposals
            .filter((p) => p.kind === "DECAY_AUTO" && p.weak !== null)
            .map((p) => ({
              weakKeyword: p.weak?.keyword ?? null,
              strongKeyword: p.strong.keyword,
            }));
          if (autoPairs.length > 0) {
            batches.push({ locale: loc.locale, pairs: autoPairs });
          }
        } catch {
          // Skip this locale — keep going on the others.
        }
      }
    }

    // ── Apply each batch atomically ────────────────────────────────
    const perLocale: {
      locale: string;
      territory: string;
      before: string;
      after: string;
      applied: number;
      pairs: { weakKeyword: string | null; strongKeyword: string; status: string }[];
    }[] = [];
    let totalApplied = 0;
    const newTrackedKeywords = new Set<string>();

    for (const batch of batches) {
      const localization = await prisma.appLocalization.findUnique({
        where: { appId_locale: { appId: id, locale: batch.locale } },
        select: { id: true, keywords: true },
      });
      if (!localization) {
        perLocale.push({
          locale: batch.locale,
          territory: deriveTerritory(batch.locale),
          before: "",
          after: "",
          applied: 0,
          pairs: batch.pairs.map((p) => ({
            ...p,
            status: "locale-missing",
          })),
        });
        continue;
      }

      const result = applyAstroSwaps(localization.keywords ?? "", batch.pairs);
      const dirty = result.applied > 0;
      if (dirty) {
        await prisma.appLocalization.update({
          where: { id: localization.id },
          data: { keywords: result.after, dirty: true },
        });

        // Mirror new strong keywords into TrackedKeyword so the next
        // research job collects signals for them. Idempotent on the
        // unique index (appId, keyword, territory).
        const territory = deriveTerritory(batch.locale);
        for (const p of batch.pairs) {
          if (
            !result.appliedKeywords.has(p.strongKeyword.toLowerCase()) &&
            p.weakKeyword !== null
          )
            continue;
          if (!result.appliedKeywords.has(p.strongKeyword.toLowerCase())) continue;
          try {
            await prisma.trackedKeyword.upsert({
              where: {
                appId_keyword_territory: {
                  appId: id,
                  keyword: p.strongKeyword,
                  territory,
                },
              },
              update: { status: "ACTIVE" },
              create: {
                tenantId: ctx.tenant!.id,
                appId: id,
                keyword: p.strongKeyword,
                territory,
                source: "AI_SUGGESTED",
                status: "ACTIVE",
                createdById: ctx.user.id,
              },
            });
            newTrackedKeywords.add(`${territory}|${p.strongKeyword.toLowerCase()}`);
          } catch {
            // Race or unique violation — fine.
          }
        }
      }

      totalApplied += result.applied;
      perLocale.push({
        locale: batch.locale,
        territory: deriveTerritory(batch.locale),
        before: result.before,
        after: result.after,
        applied: result.applied,
        pairs: result.pairResults,
      });
    }

    return NextResponse.json({
      perLocale,
      totalApplied,
      newTrackedKeywords: newTrackedKeywords.size,
    });
  });
});

