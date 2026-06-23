import { describe, expect, test } from "vitest";
import { buildAsoRecommendTask, AsoRecommendOutput } from "../ai/prompts/asoRecommend";
import type { AsoRecommendInput } from "../ai/prompts/asoRecommend";

function baseInput(overrides: Partial<AsoRecommendInput> = {}): AsoRecommendInput {
  return {
    appName: "TestApp",
    bundleId: "com.test.app",
    primaryLocale: "en-US",
    platform: "IOS",
    primaryGenre: "Games / Puzzle",
    locales: [
      {
        locale: "en-US",
        languageName: "English (United States)",
        isPrimary: true,
        name: "TestApp: Puzzle",
        subtitle: "Quick brain teasers",
        keywordsField: "puzzle,brain,offline",
        promotionalText: "New season Friday",
        description: "A daily puzzle.",
      },
      {
        locale: "tr-TR",
        languageName: "Turkish (Turkey)",
        isPrimary: false,
        name: "TestApp: Bulmaca",
        subtitle: null,
        keywordsField: "bulmaca,beyin",
        promotionalText: null,
        description: null,
      },
    ],
    trackedKeywords: [],
    downloads30d: 5_400,
    downloadsTrendPct: -1.2,
    ...overrides,
  };
}

describe("buildAsoRecommendTask — system prompt", () => {
  test("uses the master ASO + GEO + AEO framing", () => {
    const task = buildAsoRecommendTask(baseInput());
    expect(task.systemPrompt).toMatch(/ASO \+ GEO \+ AEO/);
    expect(task.systemPrompt).toMatch(/SLOT-WEIGHT HIERARCHY/);
    expect(task.systemPrompt).toMatch(/PAINKILLER > VITAMIN/);
  });

  test("includes third-party research signals section with 0-100 scale", () => {
    const task = buildAsoRecommendTask(baseInput());
    expect(task.systemPrompt).toMatch(/THIRD-PARTY RESEARCH SIGNALS/);
    expect(task.systemPrompt).toMatch(/difficulty.{0,40}0-100/);
    expect(task.systemPrompt).toMatch(/maxReachChance.{0,40}0-100/);
    expect(task.systemPrompt).toMatch(/above 65[\s\S]{0,40}cannot/);
    expect(task.systemPrompt).toMatch(/Below 35[\s\S]{0,40}winnable/);
  });

  test("locks down task metadata and output token budget", () => {
    const task = buildAsoRecommendTask(baseInput());
    expect(task.kind).toBe("metadata.tighten");
    expect(task.taskName).toBe("submit_aso_recommendations");
    expect(task.maxOutputTokens).toBeGreaterThanOrEqual(2048);
    expect(task.temperature).toBeLessThanOrEqual(0.6);
  });

  test("forbids inventing Astro numbers", () => {
    const task = buildAsoRecommendTask(baseInput());
    expect(task.systemPrompt).toMatch(
      /NEVER invent Astro numbers for keywords NOT in the table/i,
    );
  });
});

describe("buildAsoRecommendTask — user prompt rendering", () => {
  test("includes every locale section", () => {
    const task = buildAsoRecommendTask(baseInput());
    expect(task.userPrompt).toContain("## en-US — English (United States) (primary)");
    expect(task.userPrompt).toContain("## tr-TR — Turkish (Turkey)");
  });

  test("renders the 30-day download total and signed trend arrow", () => {
    const task = buildAsoRecommendTask(baseInput({ downloadsTrendPct: 7.5 }));
    expect(task.userPrompt).toContain("30-day downloads: 5400");
    expect(task.userPrompt).toMatch(/▲ 7\.5%/);
  });

  test("renders empty-keyword field marker", () => {
    const task = buildAsoRecommendTask(
      baseInput({
        locales: [
          {
            locale: "en-US",
            languageName: "English",
            isPrimary: true,
            name: "TestApp",
            subtitle: null,
            keywordsField: null,
            promotionalText: null,
            description: null,
          },
        ],
      }),
    );
    expect(task.userPrompt).toContain("Keywords field: <empty>");
  });

  test("renders fallback tracked-keywords table without Astro signals", () => {
    const task = buildAsoRecommendTask(
      baseInput({
        trackedKeywords: [
          {
            keyword: "puzzle",
            territory: "US",
            score: 0.65,
            rank: 7,
            bucket: "CHAMPION",
            inField: true,
          },
        ],
      }),
    );
    expect(task.userPrompt).toContain("# Currently tracked keywords with measured performance");
    expect(task.userPrompt).toMatch(
      /\(format: keyword \| territory \| score \| rank \| bucket \| inField\)/,
    );
    expect(task.userPrompt).toContain("puzzle | US | 0.65 | 7 | CHAMPION | live");
    expect(task.userPrompt).toMatch(/Astro signals .* aren't connected/i);
  });

  test("renders rich tracked-keywords table when Astro signals are present", () => {
    const task = buildAsoRecommendTask(
      baseInput({
        trackedKeywords: [
          {
            keyword: "puzzle offline",
            territory: "US",
            score: 0.81,
            rank: 5,
            bucket: "CHAMPION",
            inField: true,
            volume: 84,
            maxVolume: 100,
            difficulty: 18,
            maxReachChance: 67,
          },
        ],
      }),
    );
    expect(task.userPrompt).toMatch(
      /difficulty \(0-100\) \| maxReachChance \(0-100\)/,
    );
    expect(task.userPrompt).toMatch(
      /puzzle offline \| US \| 0\.81 \| 5 \| CHAMPION \| live \| 84 \| 100 \| 18 \| 67/,
    );
    expect(task.userPrompt).toMatch(/Use the Astro signals like an ASO consultant/i);
  });

  test("description is truncated to 600 chars to control token cost", () => {
    const long = "x".repeat(1500);
    const task = buildAsoRecommendTask(
      baseInput({
        locales: [
          {
            locale: "en-US",
            languageName: "English",
            isPrimary: true,
            name: "TestApp",
            subtitle: null,
            keywordsField: null,
            promotionalText: null,
            description: long,
          },
        ],
      }),
    );
    const desc = task.userPrompt.split("Description (first 600 chars): ")[1] ?? "";
    expect(desc.length).toBeGreaterThan(0);
    expect(desc.split("\n")[0]?.length ?? 0).toBeLessThanOrEqual(600);
  });
});

describe("AsoRecommendOutput schema", () => {
  test("accepts a minimal valid pack", () => {
    const parsed = AsoRecommendOutput.parse({
      topPick: {
        change: "KEYWORD",
        locale: "en-US",
        summary: "Swap the weakest token for a long-tail painkiller term.",
        expectedLift: "A modest lift in long-tail intent rankings within a week.",
      },
      topKeywordsByLocale: [
        {
          locale: "en-US",
          suggestions: [
            {
              keyword: "headache tracker",
              predictedImpact: 88,
              reasoning:
                "Painkiller framing for medical app users searching the specific problem.",
              category: "LONG_TAIL",
            },
          ],
        },
      ],
      titlesByLocale: [{ locale: "en-US", alternatives: [] }],
      subtitlesByLocale: [],
      promosByLocale: [],
    });
    expect(parsed.topPick.change).toBe("KEYWORD");
    expect(parsed.topKeywordsByLocale[0]?.suggestions[0]?.category).toBe("LONG_TAIL");
  });

  test("rejects topPick with too-short summary", () => {
    const result = AsoRecommendOutput.safeParse({
      topPick: {
        change: "KEYWORD",
        locale: "en-US",
        summary: "too short",
        expectedLift: "Some lift expected with no specific number.",
      },
      topKeywordsByLocale: [
        {
          locale: "en-US",
          suggestions: [
            {
              keyword: "x",
              predictedImpact: 50,
              reasoning: "x".repeat(25),
              category: "CORE",
            },
          ],
        },
      ],
      titlesByLocale: [{ locale: "en-US", alternatives: [] }],
    });
    expect(result.success).toBe(false);
  });
});
