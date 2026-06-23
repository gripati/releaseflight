import { describe, expect, test, vi } from "vitest";
import { runDailyCheck } from "../dailyCheck";
import type { AlarmEvaluationInput } from "../alarmEngine";
import type {
  AsoAnalystDailyInput,
  AsoAnalystDailyOutput,
} from "../../ai/prompts/asoAnalystDaily";

function baseAlarmInput(): AlarmEvaluationInput {
  return {
    keywordDeltas: [
      {
        trackedKeywordId: "tk_1",
        keyword: "merge puzzle",
        territory: "US",
        // Was at #2 (top-3) → fell to #12 → DANGER per the engine ladder.
        rankToday: 12,
        rankYesterday: 2,
        bucketToday: "DECAY",
        bucketYesterday: "STABLE",
        scoreToday: null,
        scoreYesterday: null,
        temporal: null,
        tags: ["own"],
      },
    ],
    competitorDeltas: [],
  };
}

function baseAnalystBase(): Omit<AsoAnalystDailyInput, "alarms"> {
  return {
    appName: "TestApp",
    bundleId: "com.test.app",
    platform: "IOS",
    primaryLocale: "en-US",
    primaryGenre: null,
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
    keywordHighlights: [],
    competitorHighlights: [],
    recentChanges: null,
  };
}

describe("runDailyCheck", () => {
  test("emits engine events + notifications with stable dedupKeys", async () => {
    const result = await runDailyCheck({
      appId: "app_1",
      date: "2026-05-20",
      alarmInput: baseAlarmInput(),
      analystInputBase: baseAnalystBase(),
    });
    expect(result.events.length).toBeGreaterThan(0);
    expect(result.notifications.length).toBe(result.events.length);
    const keys = result.notifications.map((n) => n.dedupKey);
    expect(new Set(keys).size).toBe(keys.length); // all unique
    expect(keys[0]).toContain("app_1|2026-05-20|");
  });

  test("rolls up overallSeverity to the highest severity present", async () => {
    const result = await runDailyCheck({
      appId: "app_1",
      date: "2026-05-20",
      alarmInput: baseAlarmInput(), // top-3 keyword drop → danger
      analystInputBase: baseAnalystBase(),
    });
    expect(result.overallSeverity).toBe("danger");
    expect(result.counts.danger).toBeGreaterThan(0);
  });

  test("returns calm + zero notifications when nothing fires", async () => {
    const result = await runDailyCheck({
      appId: "app_1",
      date: "2026-05-20",
      alarmInput: { keywordDeltas: [], competitorDeltas: [] },
      analystInputBase: baseAnalystBase(),
    });
    expect(result.overallSeverity).toBe("calm");
    expect(result.notifications).toEqual([]);
    expect(result.analystReport).toBeNull();
  });

  test("merges AI analyst interpretations into notifications", async () => {
    const analystOutput: AsoAnalystDailyOutput = {
      headline: "Test brief",
      overallVerdict: "act",
      top3Priorities: [],
      alarmInterpretations: [
        {
          alarmId: "2026-05-20#0",
          interpretation: "Your top keyword fell because the subtitle was edited.",
          probableCause: "Subtitle edit removed the matching token.",
          nextAction: "Restore the keyword in the subtitle.",
          confidence: 80,
        },
      ],
      opportunities: [],
    };
    const runAnalyst = vi.fn(async () => analystOutput);
    const result = await runDailyCheck({
      appId: "app_1",
      date: "2026-05-20",
      alarmInput: baseAlarmInput(),
      analystInputBase: baseAnalystBase(),
      runAnalyst,
    });
    expect(runAnalyst).toHaveBeenCalledTimes(1);
    expect(result.analystReport).toEqual(analystOutput);
    expect(result.notifications[0]!.agentInterpretation).toContain("subtitle was edited");
    expect(result.notifications[0]!.agentConfidence).toBe(80);
    // message is overridden by the analyst interpretation.
    expect(result.notifications[0]!.message).toContain("subtitle was edited");
  });

  test("falls back to machine messages when the analyst throws", async () => {
    const runAnalyst = vi.fn(async () => {
      throw new Error("AI rate limited");
    });
    const result = await runDailyCheck({
      appId: "app_1",
      date: "2026-05-20",
      alarmInput: baseAlarmInput(),
      analystInputBase: baseAnalystBase(),
      runAnalyst,
    });
    expect(result.analystReport).toBeNull();
    expect(result.notifications[0]!.message).not.toBe("");
    expect(result.notifications[0]!.agentInterpretation).toBeNull();
  });

  test("skips the analyst when there are no events to interpret", async () => {
    const runAnalyst = vi.fn(async () => ({
      headline: "x",
      overallVerdict: "calm" as const,
      top3Priorities: [],
      alarmInterpretations: [],
      opportunities: [],
    }));
    const result = await runDailyCheck({
      appId: "app_1",
      date: "2026-05-20",
      alarmInput: { keywordDeltas: [], competitorDeltas: [] },
      analystInputBase: baseAnalystBase(),
      runAnalyst,
    });
    expect(runAnalyst).not.toHaveBeenCalled();
    expect(result.analystReport).toBeNull();
  });
});
