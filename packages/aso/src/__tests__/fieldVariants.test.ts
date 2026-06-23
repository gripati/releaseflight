import { describe, expect, test } from "vitest";
import {
  buildFieldVariantsTask,
  fieldKindAllowed,
  fieldMaxChars,
  strengthFromScore,
  FIELD_KINDS,
} from "../ai/prompts/fieldVariants";
import type { FieldVariantsInput } from "../ai/prompts/fieldVariants";

function baseInput(overrides: Partial<FieldVariantsInput> = {}): FieldVariantsInput {
  return {
    field: "keywords",
    appName: "TestApp",
    bundleId: "com.test.app",
    platform: "IOS",
    locale: "en-US",
    languageName: "English (United States)",
    primaryGenre: "Games / Puzzle",
    context: {
      title: "TestApp: Puzzle",
      subtitle: "Solve quick brain teasers",
      keywords: "puzzle,brain,teaser,casual",
      promo: "New seasons launch every Friday",
      description: "A daily puzzle app.",
    },
    downloads30d: 12_000,
    downloadsTrendPct: 8.4,
    trackedKeywords: [],
    count: 3,
    ...overrides,
  };
}

describe("fieldKindAllowed", () => {
  test.each([
    ["title", "IOS", true],
    ["title", "ANDROID", true],
    ["subtitle", "IOS", true],
    ["subtitle", "ANDROID", false],
    ["keywords", "IOS", true],
    ["keywords", "ANDROID", false],
    ["promo", "IOS", true],
    ["promo", "ANDROID", false],
    ["description", "IOS", true],
    ["description", "ANDROID", true],
  ] as const)("%s on %s → %s", (kind, platform, expected) => {
    expect(fieldKindAllowed(kind, platform)).toBe(expected);
  });
});

describe("fieldMaxChars", () => {
  test("title is 30 on iOS, 50 on Android", () => {
    expect(fieldMaxChars("title", "IOS")).toBe(30);
    expect(fieldMaxChars("title", "ANDROID")).toBe(50);
  });
  test("subtitle, keywords, promo, description match Apple/Google caps", () => {
    expect(fieldMaxChars("subtitle", "IOS")).toBe(30);
    expect(fieldMaxChars("keywords", "IOS")).toBe(100);
    expect(fieldMaxChars("promo", "IOS")).toBe(170);
    expect(fieldMaxChars("description", "IOS")).toBe(4000);
  });
});

describe("strengthFromScore — bucket boundaries", () => {
  test.each([
    [0, "WEAK"],
    [39, "WEAK"],
    [40, "FAIR"],
    [59, "FAIR"],
    [60, "GOOD"],
    [74, "GOOD"],
    [75, "STRONG"],
    [89, "STRONG"],
    [90, "EXCEPTIONAL"],
    [100, "EXCEPTIONAL"],
  ])("score %i → %s", (score, expected) => {
    expect(strengthFromScore(score)).toBe(expected);
  });
});

describe("FIELD_KINDS", () => {
  test("exposes the canonical 5-field set", () => {
    expect(FIELD_KINDS).toEqual([
      "title",
      "subtitle",
      "keywords",
      "promo",
      "description",
    ]);
  });
});

describe("buildFieldVariantsTask — system prompt", () => {
  test("rejects fields that aren't allowed on the platform", () => {
    expect(() =>
      buildFieldVariantsTask(baseInput({ field: "keywords", platform: "ANDROID" })),
    ).toThrow(/not available on ANDROID/);
  });

  test("contains the master persona + selected field guide (keywords)", () => {
    const task = buildFieldVariantsTask(baseInput({ field: "keywords" }));
    expect(task.systemPrompt).toMatch(/Strategist/);
    expect(task.systemPrompt).toMatch(/PAINKILLER > VITAMIN/);
    expect(task.systemPrompt).toMatch(/KEYWORDS FIELD — iOS only/);
  });

  test("title field uses TITLE_GUIDE", () => {
    const task = buildFieldVariantsTask(baseInput({ field: "title" }));
    expect(task.systemPrompt).toMatch(/TITLE — the highest-weight ASO slot/);
  });

  test("subtitle field uses SUBTITLE_GUIDE", () => {
    const task = buildFieldVariantsTask(baseInput({ field: "subtitle" }));
    expect(task.systemPrompt).toMatch(/SUBTITLE — iOS only/);
  });

  test("description field uses DESCRIPTION_GUIDE + AEO answer blocks", () => {
    const task = buildFieldVariantsTask(baseInput({ field: "description" }));
    expect(task.systemPrompt).toMatch(/DESCRIPTION — long-form, GEO \+ AEO-aware/);
    expect(task.systemPrompt).toMatch(/AEO ANSWER BLOCKS/);
  });

  test("third-party research signals section uses 0-100 scale", () => {
    const task = buildFieldVariantsTask(baseInput({ field: "keywords" }));
    expect(task.systemPrompt).toMatch(/difficulty.{0,40}0-100/);
    expect(task.systemPrompt).toMatch(/maxReachChance.{0,40}0-100/);
    expect(task.systemPrompt).toMatch(/> 65[\s\S]{0,40}unwinnable/);
    expect(task.systemPrompt).toMatch(/≥ 40[\s\S]{0,40}good slot/);
  });
});

describe("buildFieldVariantsTask — user prompt rendering", () => {
  test("renders app context + char budget", () => {
    const task = buildFieldVariantsTask(baseInput({ field: "title", platform: "IOS" }));
    expect(task.userPrompt).toContain("Char budget:");
    expect(task.userPrompt).toContain("/ 30");
    expect(task.userPrompt).toContain("Genre:      Games / Puzzle");
  });

  test("renders trends arrow when downloadsTrendPct present", () => {
    const upTask = buildFieldVariantsTask(baseInput({ downloadsTrendPct: 12.3 }));
    expect(upTask.userPrompt).toMatch(/▲ 12\.3%/);
    const downTask = buildFieldVariantsTask(baseInput({ downloadsTrendPct: -4.1 }));
    expect(downTask.userPrompt).toMatch(/▼ -4\.1%/);
  });

  test("omits tracked-keywords section when trackedKeywords is empty", () => {
    const task = buildFieldVariantsTask(baseInput({ trackedKeywords: [] }));
    expect(task.userPrompt).not.toContain("Live keyword performance");
  });

  test("renders fallback table without Astro signals", () => {
    const task = buildFieldVariantsTask(
      baseInput({
        trackedKeywords: [
          { keyword: "puzzle", score: 0.7, rank: 3, bucket: "CHAMPION" },
          { keyword: "brain", score: 0.4, rank: null, bucket: null },
        ],
      }),
    );
    expect(task.userPrompt).toContain("# Live keyword performance");
    expect(task.userPrompt).toMatch(/keyword \| score \(0\.\.1\) \| App Store rank \| bucket\n/);
    expect(task.userPrompt).toContain("puzzle | 0.70 | 3 | CHAMPION");
    expect(task.userPrompt).toContain("brain | 0.40 | off | —");
    expect(task.userPrompt).toMatch(/not connected for this tenant/);
  });

  test("renders rich table when at least one row has Astro signals", () => {
    const task = buildFieldVariantsTask(
      baseInput({
        trackedKeywords: [
          {
            keyword: "puzzle offline",
            score: 0.81,
            rank: 5,
            bucket: "CHAMPION",
            volume: 80,
            maxVolume: 100,
            difficulty: 22,
            maxReachChance: 58,
          },
        ],
      }),
    );
    expect(task.userPrompt).toMatch(
      /difficulty \(0-100\) \| maxReachChance \(0-100\)/,
    );
    expect(task.userPrompt).toMatch(
      /puzzle offline \| 0\.81 \| 5 \| CHAMPION \| 80 \| 100 \| 22 \| 58/,
    );
    expect(task.userPrompt).toMatch(/winnable/);
  });

  test("keywords field appends the no-overlap directive", () => {
    const task = buildFieldVariantsTask(baseInput({ field: "keywords" }));
    expect(task.userPrompt).toMatch(/single comma-separated string/);
    expect(task.userPrompt).toMatch(/Do NOT include words that already appear/);
  });

  test("non-keywords field omits the keywords-only directives", () => {
    const task = buildFieldVariantsTask(baseInput({ field: "title" }));
    expect(task.userPrompt).not.toMatch(/single comma-separated string/);
  });
});

describe("buildFieldVariantsTask — token + temperature budgets", () => {
  test("description gets the largest token budget", () => {
    const desc = buildFieldVariantsTask(baseInput({ field: "description" }));
    const title = buildFieldVariantsTask(baseInput({ field: "title" }));
    expect(desc.maxOutputTokens).toBeGreaterThan(title.maxOutputTokens ?? 0);
  });
  test("temperature is conservative (≤ 0.6) for ASO", () => {
    const task = buildFieldVariantsTask(baseInput());
    expect(task.temperature).toBeLessThanOrEqual(0.6);
  });
});
