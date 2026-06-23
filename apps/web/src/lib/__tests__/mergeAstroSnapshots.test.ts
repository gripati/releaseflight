import { describe, expect, test } from "vitest";
import {
  mergeAstroSnapshots,
  type AnalyzeJobResult,
  type CompletedJobInput,
} from "../mergeAstroSnapshots";

/** Helper to build a minimal job input for tests. The merge function
 *  expects newest-first ordering — we pass `finishedAt` strings the
 *  caller controls so tests don't depend on the underlying clock. */
function mkJob(
  id: string,
  finishedAt: string | null,
  result: AnalyzeJobResult | null,
): CompletedJobInput {
  return { id, finishedAt, result };
}

function mkBucket(
  locale: string,
  territory: string,
  proposals: { kind?: string }[],
): { locale: string; territory: string; currentKeywordsField: string; proposals: { kind?: string }[]; diagnostics: null } {
  return {
    locale,
    territory,
    currentKeywordsField: "",
    proposals,
    diagnostics: null,
  };
}

describe("mergeAstroSnapshots", () => {
  test("returns null merged when no jobs supplied", () => {
    const result = mergeAstroSnapshots([]);
    expect(result.merged).toBeNull();
    expect(result.perLocaleAnalyzedAt).toEqual({});
    expect(result.perLocaleJobId).toEqual({});
  });

  test("returns null merged when no job has a usable result", () => {
    const result = mergeAstroSnapshots([
      mkJob("j1", "2026-01-01T00:00:00Z", null),
      mkJob("j2", "2026-01-02T00:00:00Z", { recommendationsByLocale: [] }),
    ]);
    expect(result.merged).toBeNull();
    expect(result.perLocaleAnalyzedAt).toEqual({});
  });

  test("single job: surfaces its locales as-is", () => {
    const result = mergeAstroSnapshots([
      mkJob("j1", "2026-05-19T12:00:00Z", {
        astroAppId: "astro_42",
        endpoint: "https://astro.example.com",
        durationMs: 4200,
        recommendationsByLocale: [
          mkBucket("en-US", "US", [{ kind: "DECAY_AUTO" }, { kind: "OPPORTUNITY_PREVIEW" }]),
          mkBucket("fr-FR", "FR", [{ kind: "OPPORTUNITY_PREVIEW" }]),
        ],
        syncByTerritory: [
          { territory: "US", added: 5, skipped: 2, skippedKeywords: [] },
          { territory: "FR", added: 3, skipped: 0, skippedKeywords: [] },
        ],
      }),
    ]);
    expect(result.merged).not.toBeNull();
    expect(result.merged!.recommendationsByLocale).toHaveLength(2);
    expect(result.merged!.syncByTerritory).toHaveLength(2);
    expect(result.merged!.totals).toEqual({
      added: 8,
      skipped: 2,
      proposals: 3,
      autoSwaps: 1,
      opportunities: 2,
    });
    expect(result.merged!.astroAppId).toBe("astro_42");
    expect(result.merged!.endpoint).toBe("https://astro.example.com");
    expect(result.merged!.durationMs).toBe(4200);
    expect(result.perLocaleAnalyzedAt).toEqual({
      "en-US": "2026-05-19T12:00:00Z",
      "fr-FR": "2026-05-19T12:00:00Z",
    });
    expect(result.perLocaleJobId).toEqual({
      "en-US": "j1",
      "fr-FR": "j1",
    });
  });

  test("two jobs, no locale overlap: union", () => {
    // jobs MUST be newest-first
    const result = mergeAstroSnapshots([
      mkJob("j2", "2026-05-19T12:00:00Z", {
        recommendationsByLocale: [mkBucket("fr-FR", "FR", [{ kind: "DECAY_AUTO" }])],
        syncByTerritory: [{ territory: "FR", added: 1, skipped: 0, skippedKeywords: [] }],
      }),
      mkJob("j1", "2026-05-18T12:00:00Z", {
        recommendationsByLocale: [mkBucket("en-US", "US", [{ kind: "DECAY_AUTO" }])],
        syncByTerritory: [{ territory: "US", added: 1, skipped: 0, skippedKeywords: [] }],
      }),
    ]);
    expect(result.merged!.recommendationsByLocale).toHaveLength(2);
    expect(result.merged!.recommendationsByLocale.map((b) => b.locale).sort()).toEqual([
      "en-US",
      "fr-FR",
    ]);
    expect(result.merged!.totals.proposals).toBe(2);
    expect(result.merged!.totals.autoSwaps).toBe(2);
    expect(result.perLocaleJobId).toEqual({ "fr-FR": "j2", "en-US": "j1" });
    expect(result.perLocaleAnalyzedAt).toEqual({
      "fr-FR": "2026-05-19T12:00:00Z",
      "en-US": "2026-05-18T12:00:00Z",
    });
  });

  test("locale overlap: newest job wins for that locale", () => {
    // Two jobs both touched en-US. Newest must win.
    const result = mergeAstroSnapshots([
      mkJob("j_new", "2026-05-19T12:00:00Z", {
        recommendationsByLocale: [
          mkBucket("en-US", "US", [{ kind: "DECAY_AUTO" }, { kind: "DECAY_AUTO" }]),
        ],
        syncByTerritory: [{ territory: "US", added: 7, skipped: 1, skippedKeywords: [] }],
      }),
      mkJob("j_old", "2026-05-01T12:00:00Z", {
        recommendationsByLocale: [
          mkBucket("en-US", "US", [{ kind: "OPPORTUNITY_PREVIEW" }]),
          mkBucket("de-DE", "DE", [{ kind: "OPPORTUNITY_PREVIEW" }]),
        ],
        syncByTerritory: [
          { territory: "US", added: 99, skipped: 99, skippedKeywords: [] },
          { territory: "DE", added: 2, skipped: 0, skippedKeywords: [] },
        ],
      }),
    ]);
    // en-US comes from j_new; de-DE survives from j_old
    const enUS = result.merged!.recommendationsByLocale.find((b) => b.locale === "en-US")!;
    expect(enUS.proposals).toHaveLength(2);
    expect(enUS.proposals.every((p) => p.kind === "DECAY_AUTO")).toBe(true);
    const deDE = result.merged!.recommendationsByLocale.find((b) => b.locale === "de-DE")!;
    expect(deDE.proposals).toHaveLength(1);
    // US sync from j_new (NOT the stale 99/99)
    const usSync = result.merged!.syncByTerritory.find((b) => b.territory === "US")!;
    expect(usSync.added).toBe(7);
    expect(usSync.skipped).toBe(1);
    // DE sync from j_old preserved
    const deSync = result.merged!.syncByTerritory.find((b) => b.territory === "DE")!;
    expect(deSync.added).toBe(2);
    // Per-locale provenance
    expect(result.perLocaleJobId).toEqual({ "en-US": "j_new", "de-DE": "j_old" });
    expect(result.perLocaleAnalyzedAt).toEqual({
      "en-US": "2026-05-19T12:00:00Z",
      "de-DE": "2026-05-01T12:00:00Z",
    });
  });

  test("single-locale re-run does NOT wipe other locales", () => {
    // Realistic scenario: full-app run last week analysed [en-US, fr-FR,
    // de-DE]; then user re-runs only fr-FR today. The merged view must
    // still show en-US + de-DE from the older job.
    const result = mergeAstroSnapshots([
      mkJob("j_today_fr_only", "2026-05-19T10:00:00Z", {
        targetLocales: ["fr-FR"],
        recommendationsByLocale: [
          mkBucket("fr-FR", "FR", [{ kind: "DECAY_AUTO" }, { kind: "OPPORTUNITY_PREVIEW" }]),
        ],
        syncByTerritory: [{ territory: "FR", added: 4, skipped: 0, skippedKeywords: [] }],
      }),
      mkJob("j_last_week_all", "2026-05-12T10:00:00Z", {
        targetLocales: null,
        recommendationsByLocale: [
          mkBucket("en-US", "US", [{ kind: "OPPORTUNITY_PREVIEW" }]),
          mkBucket("fr-FR", "FR", [{ kind: "OPPORTUNITY_PREVIEW" }]),
          mkBucket("de-DE", "DE", [{ kind: "DECAY_AUTO" }]),
        ],
        syncByTerritory: [
          { territory: "US", added: 8, skipped: 1, skippedKeywords: [] },
          { territory: "FR", added: 8, skipped: 1, skippedKeywords: [] },
          { territory: "DE", added: 8, skipped: 1, skippedKeywords: [] },
        ],
      }),
    ]);
    const locales = result.merged!.recommendationsByLocale
      .map((b) => b.locale)
      .sort();
    expect(locales).toEqual(["de-DE", "en-US", "fr-FR"]);
    // fr-FR proposals come from TODAY's job
    const fr = result.merged!.recommendationsByLocale.find(
      (b) => b.locale === "fr-FR",
    )!;
    expect(fr.proposals).toHaveLength(2);
    // en-US + de-DE proposals survive from last week's run
    const en = result.merged!.recommendationsByLocale.find(
      (b) => b.locale === "en-US",
    )!;
    expect(en.proposals).toHaveLength(1);
    const de = result.merged!.recommendationsByLocale.find(
      (b) => b.locale === "de-DE",
    )!;
    expect(de.proposals).toHaveLength(1);
    // Provenance
    expect(result.perLocaleJobId["fr-FR"]).toBe("j_today_fr_only");
    expect(result.perLocaleJobId["en-US"]).toBe("j_last_week_all");
    expect(result.perLocaleJobId["de-DE"]).toBe("j_last_week_all");
    // Today's run is fresher than last week's for FR
    expect(result.perLocaleAnalyzedAt["fr-FR"]).toBe("2026-05-19T10:00:00Z");
    expect(result.perLocaleAnalyzedAt["en-US"]).toBe("2026-05-12T10:00:00Z");
  });

  test("totals recompute from merged set, not from any single job's totals", () => {
    // Both jobs have a `totals` block — we should IGNORE them and
    // recount from the merged buckets. Otherwise overlapping locales
    // would be double-counted.
    const result = mergeAstroSnapshots([
      mkJob("j_new", "2026-05-19T12:00:00Z", {
        totals: {
          added: 999,
          skipped: 999,
          proposals: 999,
          autoSwaps: 999,
          opportunities: 999,
        },
        recommendationsByLocale: [
          mkBucket("en-US", "US", [
            { kind: "DECAY_AUTO" },
            { kind: "OPPORTUNITY_PREVIEW" },
          ]),
        ],
        syncByTerritory: [
          { territory: "US", added: 5, skipped: 2, skippedKeywords: [] },
        ],
      }),
      mkJob("j_old", "2026-05-01T12:00:00Z", {
        totals: {
          added: 999,
          skipped: 999,
          proposals: 999,
          autoSwaps: 999,
          opportunities: 999,
        },
        recommendationsByLocale: [
          mkBucket("en-US", "US", [{ kind: "OPPORTUNITY_PREVIEW" }]), // masked
          mkBucket("de-DE", "DE", [{ kind: "DECAY_AUTO" }]),
        ],
        syncByTerritory: [
          { territory: "US", added: 999, skipped: 999, skippedKeywords: [] }, // masked
          { territory: "DE", added: 3, skipped: 0, skippedKeywords: [] },
        ],
      }),
    ]);
    // Merged: en-US (2 proposals: 1 DECAY + 1 OPP) + de-DE (1 DECAY)
    expect(result.merged!.totals).toEqual({
      added: 5 + 3,          // US (new) + DE (old)
      skipped: 2 + 0,
      proposals: 2 + 1,
      autoSwaps: 1 + 1,
      opportunities: 1 + 0,
    });
  });

  test("ignores buckets with malformed locale field", () => {
    const result = mergeAstroSnapshots([
      mkJob("j1", "2026-05-19T12:00:00Z", {
        recommendationsByLocale: [
          // @ts-expect-error — intentional malformed bucket
          { locale: null, territory: "X", currentKeywordsField: "", proposals: [], diagnostics: null },
          mkBucket("en-US", "US", [{ kind: "DECAY_AUTO" }]),
        ],
      }),
    ]);
    expect(result.merged!.recommendationsByLocale).toHaveLength(1);
    expect(result.merged!.recommendationsByLocale[0]!.locale).toBe("en-US");
  });

  test("preserves astroAppId + endpoint from newest job that has them", () => {
    const result = mergeAstroSnapshots([
      mkJob("j_new", "2026-05-19T12:00:00Z", {
        astroAppId: "astro_NEW",
        endpoint: "https://new.example.com",
        recommendationsByLocale: [mkBucket("en-US", "US", [])],
      }),
      mkJob("j_old", "2026-05-01T12:00:00Z", {
        astroAppId: "astro_OLD",
        endpoint: "https://old.example.com",
        recommendationsByLocale: [mkBucket("de-DE", "DE", [])],
      }),
    ]);
    expect(result.merged!.astroAppId).toBe("astro_NEW");
    expect(result.merged!.endpoint).toBe("https://new.example.com");
  });

  test("falls through to older job for astroAppId when newest lacks it", () => {
    const result = mergeAstroSnapshots([
      mkJob("j_new", "2026-05-19T12:00:00Z", {
        // astroAppId omitted
        recommendationsByLocale: [mkBucket("en-US", "US", [])],
      }),
      mkJob("j_old", "2026-05-01T12:00:00Z", {
        astroAppId: "astro_OLD",
        endpoint: "https://old.example.com",
        recommendationsByLocale: [mkBucket("de-DE", "DE", [])],
      }),
    ]);
    expect(result.merged!.astroAppId).toBe("astro_OLD");
    expect(result.merged!.endpoint).toBe("https://old.example.com");
  });

  test("omits perLocaleAnalyzedAt entries when finishedAt is null", () => {
    const result = mergeAstroSnapshots([
      mkJob("j_no_finish", null, {
        recommendationsByLocale: [mkBucket("en-US", "US", [{ kind: "DECAY_AUTO" }])],
      }),
    ]);
    expect(result.merged!.recommendationsByLocale).toHaveLength(1);
    expect(result.perLocaleAnalyzedAt).toEqual({});
    expect(result.perLocaleJobId).toEqual({});
  });
});
