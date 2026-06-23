/**
 * Bridge the app's own per-locale keywords field into the keyword
 * watchlist.
 *
 * iOS apps carry a 100-char `keywords` field on each AppLocalization
 * (comma-separated tokens). Those terms are already the ones the
 * publisher decided to optimise for — they should be tracked
 * automatically rather than re-typed into the watchlist.
 *
 * We:
 *   1. Read every locale's `keywords` field for the app.
 *   2. Tokenise on `,` (and strip surrounding whitespace).
 *   3. Derive a territory from the locale (e.g. en-US → US, tr-TR → TR;
 *      `en` alone falls back to US — Apple's worldwide default).
 *   4. Upsert one `TrackedKeyword` per (keyword × territory), tagged
 *      with `source = APP_METADATA` so the UI can render them with a
 *      distinct stamp.
 *
 * No deletes. If the user removes a token from the keywords field, the
 * old TrackedKeyword stays — it's a *historical* record. The UI lets
 * the user archive it manually.
 *
 * Returns a summary so callers can show a toast like
 * "Imported 14 keywords across 3 locales (2 already tracked)".
 */
import { prisma } from "@marquee/db";
import { localeRegion } from "@marquee/core";

export interface KeywordsFromMetadataSummary {
  importedCount: number;
  skippedExisting: number;
  perLocale: { locale: string; tokens: number; imported: number }[];
}

export async function syncKeywordsFromMetadata(params: {
  tenantId: string;
  appId: string;
  userId: string;
  /** Only import these locales (default: every locale on the app). */
  locales?: string[];
}): Promise<KeywordsFromMetadataSummary> {
  const localizations = await prisma.appLocalization.findMany({
    where: {
      appId: params.appId,
      ...(params.locales ? { locale: { in: params.locales } } : {}),
    },
    select: { locale: true, keywords: true },
  });

  let imported = 0;
  let skipped = 0;
  const perLocale: KeywordsFromMetadataSummary["perLocale"] = [];

  for (const loc of localizations) {
    const tokens = parseKeywordsField(loc.keywords);
    const territory = deriveTerritory(loc.locale);
    let localeImported = 0;
    for (const token of tokens) {
      const existing = await prisma.trackedKeyword.findUnique({
        where: {
          appId_keyword_territory: {
            appId: params.appId,
            keyword: token,
            territory,
          },
        },
      });
      if (existing) {
        skipped += 1;
        // Idempotent: ensure the "default" tag stays attached even if
        // the row was created via an older code path (or the user
        // manually edited tags). We never strip user-added tags —
        // just guarantee `default` is present.
        if (!existing.tags.map((t) => t.toLowerCase()).includes("default")) {
          await prisma.trackedKeyword.update({
            where: { id: existing.id },
            data: { tags: { set: [...existing.tags, "default"] } },
          });
        }
        continue;
      }
      await prisma.trackedKeyword.create({
        data: {
          tenantId: params.tenantId,
          appId: params.appId,
          keyword: token,
          territory,
          source: "APP_METADATA",
          // Auto-tag as "default" so the daily-tracking UI can
          // visually distinguish ground-truth metadata keywords from
          // ones swapped in via the Astro suggestion workflow
          // (tags=["adopted"]).
          tags: ["default"],
          notes: `Imported from ${loc.locale} keywords field`,
          createdById: params.userId,
        },
      });
      imported += 1;
      localeImported += 1;
    }
    perLocale.push({ locale: loc.locale, tokens: tokens.length, imported: localeImported });
  }

  return {
    importedCount: imported,
    skippedExisting: skipped,
    perLocale,
  };
}

/**
 * Tokenise an iOS keywords field. Apple counts characters including
 * commas, so we expect comma-separated tokens (no spaces around commas
 * is recommended). Punctuation other than commas stays — multi-word
 * phrases like "tower defense" are valid tokens. We collapse whitespace
 * and drop empty / very-short tokens.
 */
export function parseKeywordsField(raw: string | null | undefined): string[] {
  if (!raw) return [];
  return Array.from(
    new Set(
      raw
        .split(",")
        .map((t) => t.trim().replace(/\s+/g, " "))
        .filter((t) => t.length >= 2 && t.length <= 80),
    ),
  );
}

/**
 * Derive an App Store storefront (ISO 3166-1 alpha-2) from a canonical
 * locale string. Delegates to the single source of truth in
 * @marquee/core/locale so every layer of the system agrees on the
 * mapping (display flag, storefront filter, tracked-keyword grouping).
 *
 *   en-US → US, tr-TR → TR, pt-BR → BR, zh-Hans → CN (mainland default)
 *   ca    → ES (Catalan/Spain), sk → SK, hr → HR, etc.
 *
 * NEVER falls back to "US" silently — if the canonical map doesn't know
 * the locale we return "UN" so callers can detect the gap rather than
 * dumping every uncategorised keyword into the US storefront.
 */
export function deriveTerritory(locale: string): string {
  return localeRegion(locale);
}
