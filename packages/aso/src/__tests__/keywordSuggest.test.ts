import { describe, expect, test } from "vitest";
import {
  buildKeywordSuggestTask,
  KeywordSuggestOutput,
} from "../ai/prompts/keywordSuggest";
import type { KeywordSuggestInput } from "../ai/prompts/keywordSuggest";

function baseInput(overrides: Partial<KeywordSuggestInput> = {}): KeywordSuggestInput {
  return {
    appName: "TestApp",
    primaryLocale: "en-US",
    territories: ["US"],
    primaryGenre: "Health & Fitness",
    shortDescription: "Track your headaches.",
    longDescription: "Daily migraine diary with reminders, exports for doctors.",
    existingKeywords: ["headache", "migraine"],
    count: 10,
    ...overrides,
  };
}

describe("buildKeywordSuggestTask — system prompt", () => {
  test("always pins task metadata (kind / temperature / taskName)", () => {
    const task = buildKeywordSuggestTask(baseInput());
    expect(task.kind).toBe("keyword.suggest");
    expect(task.taskName).toBe("submit_keyword_suggestions");
    expect(task.temperature).toBeLessThanOrEqual(0.5);
    expect(task.maxOutputTokens).toBeGreaterThanOrEqual(1024);
  });

  test("includes the master ASO + GEO + AEO framing", () => {
    const task = buildKeywordSuggestTask(baseInput());
    expect(task.systemPrompt).toMatch(/ASO \+ GEO \+ AEO/);
    expect(task.systemPrompt).toMatch(/PAINKILLER > VITAMIN/);
    expect(task.systemPrompt).toMatch(/CLUSTER TAXONOMY/);
  });

  test("includes the third-party research signals section with correct thresholds", () => {
    const task = buildKeywordSuggestTask(baseInput());
    // Difficulty + maxReachChance are stored on the 0-100 scale in KeywordSignal.
    // The prompt must reflect that scale (not the older 0..1 scale).
    expect(task.systemPrompt).toMatch(/difficulty.{0,40}0-100/);
    expect(task.systemPrompt).toMatch(/maxReachChance.{0,40}0-100/);
    expect(task.systemPrompt).toMatch(/> 65[\s\S]{0,40}unwinnable/);
    expect(task.systemPrompt).toMatch(/< 35[\s\S]{0,40}winnable/);
  });

  test("forbids inventing third-party numbers for keywords NOT in the table", () => {
    const task = buildKeywordSuggestTask(baseInput());
    expect(task.systemPrompt).toMatch(
      /NEVER invent third-party numbers for keywords NOT in the table/i,
    );
  });
});

describe("buildKeywordSuggestTask — user prompt rendering", () => {
  test("renders existing keywords as a bulleted list", () => {
    const task = buildKeywordSuggestTask(baseInput());
    expect(task.userPrompt).toContain("Already tracked");
    expect(task.userPrompt).toContain("- headache");
    expect(task.userPrompt).toContain("- migraine");
  });

  test("renders the target count + cluster list", () => {
    const task = buildKeywordSuggestTask(baseInput({ count: 18 }));
    expect(task.userPrompt).toMatch(/Return exactly 18 candidate keywords/);
    expect(task.userPrompt).toMatch(
      /CORE \/ LONG_TAIL \/ SYNONYM \/ COMPETITOR_BORROW/,
    );
  });

  test("omits performance section when performanceContext is missing", () => {
    const task = buildKeywordSuggestTask(baseInput());
    expect(task.userPrompt).not.toContain("# Live keyword performance");
  });

  test("renders fallback table when performanceContext has no third-party signals", () => {
    const task = buildKeywordSuggestTask(
      baseInput({
        performanceContext: [
          {
            keyword: "headache tracker",
            score: 0.62,
            rank: 14,
            bucket: "OPPORTUNITY",
          },
          {
            keyword: "migraine diary",
            score: 0.71,
            rank: 8,
            bucket: "CHAMPION",
          },
        ],
      }),
    );
    expect(task.userPrompt).toContain("# Live keyword performance");
    // Fallback table — header has score|rank|bucket, NO Astro columns
    expect(task.userPrompt).toMatch(/keyword \| score \(0\.\.1\) \| App Store rank \| bucket\n/);
    expect(task.userPrompt).toContain("headache tracker | 0.62 | 14 | OPPORTUNITY");
    expect(task.userPrompt).toContain("migraine diary | 0.71 | 8 | CHAMPION");
    expect(task.userPrompt).toMatch(
      /third-party signals .* are not connected/i,
    );
  });

  test("renders rich table when Astro signals are present", () => {
    const task = buildKeywordSuggestTask(
      baseInput({
        performanceContext: [
          {
            keyword: "headache tracker",
            score: 0.62,
            rank: 14,
            bucket: "OPPORTUNITY",
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
    // Row should print integers as-is, not as toFixed(2) (0..1 mistake).
    expect(task.userPrompt).toMatch(/headache tracker \| 0\.62 \| 14 \| OPPORTUNITY \| 84 \| 100 \| 18 \| 67/);
    expect(task.userPrompt).toMatch(/empirical anchor/i);
  });

  test("rich table renders — when one row has Astro and another doesn't", () => {
    const task = buildKeywordSuggestTask(
      baseInput({
        performanceContext: [
          {
            keyword: "headache tracker",
            score: 0.62,
            rank: 14,
            bucket: "OPPORTUNITY",
            volume: 4200,
            difficulty: 18,
          },
          {
            keyword: "lonely word",
            score: 0.4,
            rank: null,
            bucket: null,
          },
        ],
      }),
    );
    // Triggers the hasResearch=true branch
    expect(task.userPrompt).toContain("difficulty (0-100)");
    // The row without Astro signals must still render with "—" placeholders
    expect(task.userPrompt).toMatch(
      /lonely word \| 0\.40 \| off \| — \| — \| — \| — \| —/,
    );
  });
});

describe("KeywordSuggestOutput schema", () => {
  test("normalises non-canonical bucket vocabulary (PAINKILLER) to LONG_TAIL", () => {
    const parsed = KeywordSuggestOutput.parse({
      suggestions: [
        {
          keyword: "chronic pain",
          rationale: "Painkiller framing for medical app users.",
          predictedRelevance: 88,
          bucket: "PAINKILLER",
          suggestedTerritory: "US",
        },
      ],
      notes: null,
    });
    expect(parsed.suggestions[0]?.bucket).toBe("LONG_TAIL");
  });

  test("normalises hyphenated and lowercase bucket variants", () => {
    const parsed = KeywordSuggestOutput.parse({
      suggestions: [
        {
          keyword: "match-3 puzzle",
          rationale: "Synonym test.",
          predictedRelevance: 60,
          bucket: "long-tail",
          suggestedTerritory: "US",
        },
        {
          keyword: "tower defense",
          rationale: "Core category.",
          predictedRelevance: 75,
          bucket: "core",
          suggestedTerritory: "US",
        },
      ],
      notes: null,
    });
    expect(parsed.suggestions[0]?.bucket).toBe("LONG_TAIL");
    expect(parsed.suggestions[1]?.bucket).toBe("CORE");
  });

  test("accepts notes as null (OpenAI strict-mode shape)", () => {
    const parsed = KeywordSuggestOutput.parse({
      suggestions: [
        {
          keyword: "x",
          rationale: "y",
          predictedRelevance: 50,
          bucket: "CORE",
          suggestedTerritory: "US",
        },
      ],
      notes: null,
    });
    expect(parsed.notes).toBeNull();
  });
});
