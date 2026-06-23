import { describe, expect, test } from "vitest";
import {
  buildAsoAnalystDailyTask,
  AsoAnalystDailyOutput,
} from "../ai/prompts/asoAnalystDaily";
import type { AsoAnalystDailyInput } from "../ai/prompts/asoAnalystDaily";

function baseInput(overrides: Partial<AsoAnalystDailyInput> = {}): AsoAnalystDailyInput {
  return {
    appName: "TestPuzzle",
    bundleId: "com.test.puzzle",
    platform: "IOS",
    primaryLocale: "en-US",
    primaryGenre: "Games / Puzzle",
    metrics: {
      date: "2026-05-20",
      downloadsToday: 1820,
      downloadsYesterday: 2100,
      downloads7dAvg: 2050,
      impressionsToday: 38_400,
      impressionsYesterday: 41_200,
      cvrToday: 4.7,
      cvrYesterday: 5.1,
      cvr7dAvg: 5.0,
      ratingToday: 4.4,
      ratingYesterday: 4.6,
      newLowStarReviewsToday: 6,
    },
    keywordHighlights: [
      {
        trackedKeywordId: "tk_own_1",
        keyword: "merge puzzle",
        territory: "US",
        tags: ["own"],
        rankToday: 12,
        rankYesterday: 5,
        bucketToday: "DECAY",
      },
    ],
    competitorHighlights: [
      {
        competitorId: "c_1",
        competitorName: "Rival Inc",
        keyword: "merge puzzle",
        rankToday: 4,
        rankYesterday: 18,
        ourRankToday: 12,
      },
    ],
    alarms: [
      {
        id: "alarm_1",
        kind: "KEYWORD_RANK_DROP",
        severity: "danger",
        title: "\"merge puzzle\" fell 7 positions in US",
        message: "Was #5, now #12.",
        payload: { drop: 7, rankYesterday: 5, rankToday: 12 },
        trackedKeywordId: "tk_own_1",
      },
      {
        id: "alarm_2",
        kind: "COMPETITOR_OVERTOOK_US",
        severity: "danger",
        title: "Rival Inc overtook you on \"merge puzzle\"",
        message: "Now ranks #4 vs your #12.",
        payload: { competitorName: "Rival Inc", rankToday: 4, ourRankToday: 12 },
        competitorId: "c_1",
      },
    ],
    recentChanges: "Yesterday: pushed new screenshots in en-US, dropped 'merge' token from subtitle",
    ...overrides,
  };
}

describe("buildAsoAnalystDailyTask — system prompt", () => {
  test("uses the senior-consultant persona framing", () => {
    const task = buildAsoAnalystDailyTask(baseInput());
    expect(task.systemPrompt).toMatch(/senior ASO consultant/i);
    expect(task.systemPrompt).toMatch(/OUTPUT DISCIPLINE/);
    expect(task.systemPrompt).toMatch(/CAUSE ATTRIBUTION/);
  });

  test("documents the verdict ladder", () => {
    const task = buildAsoAnalystDailyTask(baseInput());
    expect(task.systemPrompt).toMatch(/calm[\s\S]{0,200}watch[\s\S]{0,200}act[\s\S]{0,200}critical/);
  });

  test("forbids skipping alarms", () => {
    const task = buildAsoAnalystDailyTask(baseInput());
    expect(task.systemPrompt).toMatch(/EVERY input alarm gets exactly one entry/);
    expect(task.systemPrompt).toMatch(/Do not skip alarms/);
  });

  test("locks down task metadata and budgets", () => {
    const task = buildAsoAnalystDailyTask(baseInput());
    expect(task.kind).toBe("anomaly.explain");
    expect(task.taskName).toBe("submit_daily_analyst_brief");
    expect(task.maxOutputTokens).toBeGreaterThanOrEqual(1500);
    expect(task.temperature).toBeLessThanOrEqual(0.5);
  });
});

describe("buildAsoAnalystDailyTask — user prompt rendering", () => {
  test("renders metric snapshot with today / yesterday / 7d-avg slots", () => {
    const task = buildAsoAnalystDailyTask(baseInput());
    expect(task.userPrompt).toContain("Downloads today vs yesterday vs 7d-avg: 1820 / 2100 / 2050");
    expect(task.userPrompt).toContain("CVR % today vs yesterday vs 7d-avg: 4.70 / 5.10 / 5.00");
    expect(task.userPrompt).toContain("Rating today vs yesterday: 4.40 / 4.60");
    expect(task.userPrompt).toContain("New low-star reviews today: 6");
  });

  test("renders keyword highlights with tags + rank arrows", () => {
    const task = buildAsoAnalystDailyTask(baseInput());
    expect(task.userPrompt).toContain("merge puzzle | US | own | #5 → #12 | DECAY");
  });

  test("renders competitor highlights with their and our rank columns", () => {
    const task = buildAsoAnalystDailyTask(baseInput());
    expect(task.userPrompt).toContain("Rival Inc | merge puzzle | #18 → #4 | our: #12");
  });

  test("renders every alarm with its full id, kind, severity and payload", () => {
    const task = buildAsoAnalystDailyTask(baseInput());
    expect(task.userPrompt).toContain("## alarm_1 [danger] KEYWORD_RANK_DROP");
    expect(task.userPrompt).toContain("## alarm_2 [danger] COMPETITOR_OVERTOOK_US");
    expect(task.userPrompt).toContain(`"drop":7`);
    expect(task.userPrompt).toContain(`"ourRankToday":12`);
  });

  test("includes recentChanges block when supplied", () => {
    const task = buildAsoAnalystDailyTask(baseInput());
    expect(task.userPrompt).toContain("Recent changes the user made");
    expect(task.userPrompt).toContain("dropped 'merge' token from subtitle");
  });

  test("renders the calm-day fallback when no alarms fired", () => {
    const task = buildAsoAnalystDailyTask(baseInput({ alarms: [] }));
    expect(task.userPrompt).toContain("(no alarms fired today — return calm verdict if metrics confirm baseline)");
  });

  test("handles missing metric values gracefully", () => {
    const task = buildAsoAnalystDailyTask(
      baseInput({
        metrics: {
          date: "2026-05-20",
          downloadsToday: null,
          downloadsYesterday: null,
          downloads7dAvg: null,
          impressionsToday: null,
          impressionsYesterday: null,
          cvrToday: null,
          cvrYesterday: null,
          cvr7dAvg: null,
          ratingToday: null,
          ratingYesterday: null,
          newLowStarReviewsToday: 0,
        },
      }),
    );
    expect(task.userPrompt).toContain("Downloads today vs yesterday vs 7d-avg: — / — / —");
    expect(task.userPrompt).toContain("Rating today vs yesterday: — / —");
  });
});

describe("AsoAnalystDailyOutput schema", () => {
  test("accepts a minimal valid brief", () => {
    const parsed = AsoAnalystDailyOutput.safeParse({
      headline: "Rating fell 0.2 stars after yesterday's screenshot push — review-driven.",
      overallVerdict: "act",
      top3Priorities: [
        {
          rank: 1,
          action: "Read today's new 1-star reviews and group complaints into themes.",
          rationale: "Rating drops cascade into CVR within 3-5 days if the cause isn't isolated.",
          expectedOutcome: "Concrete fix list for the next build.",
        },
      ],
      alarmInterpretations: [
        {
          alarmId: "alarm_1",
          interpretation:
            "Your 'merge puzzle' keyword fell from #5 to #12 overnight. Most likely caused by yesterday's subtitle change that removed the matching token.",
          probableCause: "Yesterday's subtitle edit removed the 'merge' token, weakening field weight.",
          nextAction: "Re-add 'merge' to the en-US subtitle and re-submit metadata.",
          confidence: 75,
        },
      ],
      opportunities: [],
    });
    expect(parsed.success).toBe(true);
  });

  test("rejects briefs with too-short interpretation", () => {
    const parsed = AsoAnalystDailyOutput.safeParse({
      headline: "Fine.",
      overallVerdict: "calm",
      top3Priorities: [],
      alarmInterpretations: [
        {
          alarmId: "x",
          interpretation: "short", // < 20 chars
          probableCause: "noise",
          nextAction: "ignore",
          confidence: 10,
        },
      ],
      opportunities: [],
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects priorities outside rank 1-3", () => {
    const parsed = AsoAnalystDailyOutput.safeParse({
      headline: "Daily brief — nothing urgent today.",
      overallVerdict: "watch",
      top3Priorities: [
        {
          rank: 4, // out of bounds
          action: "Some action to take today before lunch.",
          rationale: "Some rationale explaining the priority order.",
          expectedOutcome: "Outcome statement.",
        },
      ],
      alarmInterpretations: [],
      opportunities: [],
    });
    expect(parsed.success).toBe(false);
  });

  test("rejects unknown overallVerdict values", () => {
    const parsed = AsoAnalystDailyOutput.safeParse({
      headline: "Daily brief — nothing urgent today.",
      overallVerdict: "panic",
      top3Priorities: [],
      alarmInterpretations: [],
      opportunities: [],
    });
    expect(parsed.success).toBe(false);
  });
});
