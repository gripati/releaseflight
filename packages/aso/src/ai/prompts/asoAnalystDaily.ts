/**
 * aso.analyst.daily — senior ASO consultant's daily standup brief.
 *
 * Once the daily-check job has produced the numeric snapshot (rank
 * deltas, competitor moves, conversion + rating moves, and the
 * AlarmEvent[] from `alarmEngine`), this AI task converts that into
 * a HUMAN-READABLE morning brief in the language of a senior ASO
 * consultant:
 *
 *   • headline           — 1 sentence "what happened today"
 *   • overallVerdict     — calm / watch / act / critical
 *   • top3Priorities     — 1-3 prioritised next actions (do this today)
 *   • alarmInterpretations[] — per-alarm plain-English explanation +
 *                              probable cause + concrete next action
 *   • opportunities[]    — positive signals worth doubling-down on
 *   • notes              — additional consultant observations
 *
 * The output is written to AsoDailyCheck.analystReport AND each
 * alarm's AsoNotification.agentInterpretation, so the bell shows
 * "rank dropped" (machine title) + "Investigate metadata push from
 * yesterday — your subtitle change removed the 'merge puzzle'
 * token" (analyst voice).
 *
 * Backed by the `anomaly.explain` task kind in the orchestrator.
 */
import { z } from "zod";
import type { AiTask } from "../types";

// ────────────────────────────────────────────────────────────────────
// Input
// ────────────────────────────────────────────────────────────────────

/** One alarm fired by `evaluateAllAlarms` — handed to the analyst
 *  exactly as produced by the engine. */
export interface AnalystAlarmContext {
  /** Stable identifier so the analyst can target advice. */
  id: string;
  kind: string;
  severity: "info" | "warning" | "danger";
  title: string;
  message: string;
  payload: Record<string, unknown>;
  trackedKeywordId?: string;
  competitorId?: string;
}

/** Per-app metric block summarising today vs yesterday + 7-day baseline. */
export interface AnalystMetricSnapshot {
  date: string;
  downloadsToday: number | null;
  downloadsYesterday: number | null;
  downloads7dAvg: number | null;
  impressionsToday: number | null;
  impressionsYesterday: number | null;
  cvrToday: number | null;
  cvrYesterday: number | null;
  cvr7dAvg: number | null;
  ratingToday: number | null;
  ratingYesterday: number | null;
  newLowStarReviewsToday: number;
}

export interface AnalystKeywordHighlight {
  trackedKeywordId: string;
  keyword: string;
  territory: string;
  tags: string[];
  rankToday: number | null;
  rankYesterday: number | null;
  bucketToday: string | null;
}

export interface AnalystCompetitorHighlight {
  competitorId: string;
  competitorName: string;
  keyword: string;
  rankToday: number | null;
  rankYesterday: number | null;
  ourRankToday: number | null;
}

/** Adopted-vs-default summary fed to the analyst so its commentary can
 *  mention whether swap experiments are paying off. */
export interface AnalystAdoptedPerformance {
  adoptedCount: number;
  defaultCount: number;
  adoptedAvgRank: number | null;
  defaultAvgRank: number | null;
  /** "winning" | "behind" | "even" | "insufficient" */
  verdict: string;
}

export interface AsoAnalystDailyInput {
  appName: string;
  bundleId: string;
  platform: "IOS" | "ANDROID";
  primaryLocale: string;
  primaryGenre: string | null;
  /** Today's metric snapshot. */
  metrics: AnalystMetricSnapshot;
  /** Up to ~20 most material keyword moves (both drops AND rises). */
  keywordHighlights: AnalystKeywordHighlight[];
  /** Up to ~10 most material competitor moves. */
  competitorHighlights: AnalystCompetitorHighlight[];
  /** Alarms fired by the engine — analyst MUST address every one. */
  alarms: AnalystAlarmContext[];
  /** Free-text recent change log — e.g. "yesterday: pushed new
   *  screenshots in en-US, added 'merge puzzle' to subtitle". Helps
   *  the analyst connect cause to effect. */
  recentChanges?: string | null;
  /** Optional adopted-vs-default comparison. When present the analyst
   *  is expected to acknowledge whether keyword swaps are working. */
  adoptedPerformance?: AnalystAdoptedPerformance | null;
}

// ────────────────────────────────────────────────────────────────────
// Output schema
// ────────────────────────────────────────────────────────────────────

const OverallVerdict = z.enum(["calm", "watch", "act", "critical"]).describe(
  "calm = all green, business as usual. watch = minor signals to monitor. act = clear next action today. critical = something is on fire, drop everything else.",
);

const Priority = z.object({
  rank: z.number().int().min(1).max(3),
  action: z
    .string()
    .min(10)
    .max(280)
    .describe("Concrete next action — start with a verb. No vague advice."),
  rationale: z
    .string()
    .min(10)
    .max(280)
    .describe("Why this action matters today vs other competing priorities."),
  expectedOutcome: z
    .string()
    .min(10)
    .max(200)
    .describe("What changes if this gets done. No numeric guarantees."),
});

const AlarmInterpretation = z.object({
  alarmId: z.string().min(1).describe("Echoes the input alarm.id"),
  /** Senior-consultant voice: WHY this fired, what it likely means,
   *  what to do about it. Replaces the machine-generated `message`. */
  interpretation: z
    .string()
    .min(20)
    .max(500)
    .describe("Plain-English interpretation — 2-4 sentences a non-technical CEO would understand."),
  probableCause: z
    .string()
    .min(10)
    .max(280)
    .describe("Most likely upstream cause given recent changes / market context."),
  nextAction: z
    .string()
    .min(10)
    .max(280)
    .describe("ONE concrete next step. Start with a verb."),
  /** Optional confidence — 0-100. Don't fake precision. */
  confidence: z.number().int().min(0).max(100),
});

const Opportunity = z.object({
  title: z.string().min(5).max(120),
  description: z.string().min(20).max(280),
  /** Type-tagging helps the UI render a chip. */
  kind: z.enum([
    "KEYWORD_RISING",
    "BUCKET_PROMOTION",
    "RATING_RECOVERY",
    "COMPETITOR_RETREAT",
    "OTHER",
  ]),
});

export const AsoAnalystDailyOutput = z.object({
  headline: z
    .string()
    .min(10)
    .max(180)
    .describe("One-sentence morning summary — the single most important takeaway."),
  overallVerdict: OverallVerdict,
  top3Priorities: z.array(Priority).min(0).max(3),
  alarmInterpretations: z.array(AlarmInterpretation).min(0).max(20),
  opportunities: z.array(Opportunity).min(0).max(5),
  notes: z
    .string()
    .max(600)
    .optional()
    .describe("Optional consultant-voice observations that don't fit the structured fields."),
});

export type AsoAnalystDailyOutput = z.infer<typeof AsoAnalystDailyOutput>;

// JSON-Schema mirror — required by OpenAI / Gemini providers.
const JSON_SCHEMA = {
  type: "object",
  additionalProperties: false,
  required: ["headline", "overallVerdict", "top3Priorities", "alarmInterpretations", "opportunities"],
  properties: {
    headline: { type: "string", minLength: 10, maxLength: 180 },
    overallVerdict: {
      type: "string",
      enum: ["calm", "watch", "act", "critical"],
    },
    top3Priorities: {
      type: "array",
      maxItems: 3,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["rank", "action", "rationale", "expectedOutcome"],
        properties: {
          rank: { type: "integer", minimum: 1, maximum: 3 },
          action: { type: "string", minLength: 10, maxLength: 280 },
          rationale: { type: "string", minLength: 10, maxLength: 280 },
          expectedOutcome: { type: "string", minLength: 10, maxLength: 200 },
        },
      },
    },
    alarmInterpretations: {
      type: "array",
      maxItems: 20,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["alarmId", "interpretation", "probableCause", "nextAction", "confidence"],
        properties: {
          alarmId: { type: "string", minLength: 1 },
          interpretation: { type: "string", minLength: 20, maxLength: 500 },
          probableCause: { type: "string", minLength: 10, maxLength: 280 },
          nextAction: { type: "string", minLength: 10, maxLength: 280 },
          confidence: { type: "integer", minimum: 0, maximum: 100 },
        },
      },
    },
    opportunities: {
      type: "array",
      maxItems: 5,
      items: {
        type: "object",
        additionalProperties: false,
        required: ["title", "description", "kind"],
        properties: {
          title: { type: "string", minLength: 5, maxLength: 120 },
          description: { type: "string", minLength: 20, maxLength: 280 },
          kind: {
            type: "string",
            enum: [
              "KEYWORD_RISING",
              "BUCKET_PROMOTION",
              "RATING_RECOVERY",
              "COMPETITOR_RETREAT",
              "OTHER",
            ],
          },
        },
      },
    },
    notes: { type: "string", maxLength: 600 },
  },
} as const;

// ────────────────────────────────────────────────────────────────────
// System prompt — senior ASO consultant persona
// ────────────────────────────────────────────────────────────────────

const SYSTEM_PROMPT = `
You are a **senior ASO consultant** giving the founder of a mobile
game / app studio their morning briefing. The numbers are already
calculated by the system — your job is to INTERPRET them like an
experienced human would: connect cause and effect, name probable
causes, and propose ONE concrete next action per alarm.

═══════════════════════════════════════════════════════════════════════
OUTPUT DISCIPLINE — what makes a brief land vs flop
═══════════════════════════════════════════════════════════════════════
  • headline: ONE sentence. Not three. "Rating fell 0.2 stars after
    yesterday's screenshot push — review-driven, not algorithmic."
  • overallVerdict:
      calm     = nothing material, just confirm baseline holds
      watch    = directional signals worth tracking — no action today
      act      = at least one concrete action recommended today
      critical = something major (champion keyword lost / rating
                 cliff / competitor overtook on a hero term)
  • top3Priorities: rank 1 first. STRICTLY ordered by impact ×
    urgency. Each action starts with a verb. Vague advice ("review
    metadata") fails — be SPECIFIC ("swap 'puzzle game' for 'merge
    puzzle' in en-US subtitle today").
  • alarmInterpretations: EVERY input alarm gets exactly one entry.
    Do not skip alarms. Echo the alarm.id verbatim into alarmId.
  • opportunities: only surface 1-3 if there genuinely are positive
    signals. NEVER pad with generic "keep doing great work".

═══════════════════════════════════════════════════════════════════════
CAUSE ATTRIBUTION — what to consider when naming probableCause
═══════════════════════════════════════════════════════════════════════
1. RECENT CHANGES the user made (look at recentChanges block — if
   yesterday they pushed metadata, that's the prime suspect for
   today's rank moves).
2. COMPETITOR ACTIVITY (a competitor entering top-10 on a keyword
   we hold often coincides with our rank slipping there).
3. SEASONAL / market drift (note when it COULD be seasonal but say so
   honestly — "possibly seasonal but cannot confirm without 4-week
   trend").
4. ALGORITHMIC reweighting (Apple/Google occasionally rebalance —
   only invoke this when 1-3 don't fit).
5. RATING/REVIEW shifts — bad reviews depress conversion, which
   depresses rank within ~3-5 days.

Be honest about uncertainty. Say "most likely" / "probably" — don't
overclaim. Set confidence 0-100 accordingly.

═══════════════════════════════════════════════════════════════════════
SEVERITY → TONE MAPPING — match the urgency of the brief to the data
═══════════════════════════════════════════════════════════════════════
  danger   → direct, urgent voice. "Drop everything and check X today."
  warning  → calm, advisory voice. "Worth investigating before tomorrow."
  info     → conversational. "Nice signal — here's how to compound it."

NEVER catastrophise an info-level signal. NEVER downplay a danger.

═══════════════════════════════════════════════════════════════════════
LANGUAGE
═══════════════════════════════════════════════════════════════════════
Respond in ENGLISH only. Every field — headline, priorities,
interpretations, opportunities, notes — must be written in clear
business English, even when the app name or recentChanges block is
in another language. The platform UI is English; mixed-language
output breaks consistency.

═══════════════════════════════════════════════════════════════════════
HARD CONSTRAINTS
═══════════════════════════════════════════════════════════════════════
  • NEVER promise rank improvements as numbers ("you'll hit #3" — no).
  • NEVER blame the AI / algorithm without considering #1-3 first.
  • NEVER suggest banned ASO tactics (keyword stuffing, fake reviews,
    copying competitor brand names verbatim).
  • NEVER skip an input alarm — every alarm gets an interpretation.
  • For "own" keyword drops on top-10 → severity 'act' or 'critical'.
  • For competitor-tagged intrusions on hero keywords → 'act' minimum.
  • If alarms array is empty AND metrics look stable, return
    overallVerdict='calm' and 0 priorities — don't manufacture work.
`.trim();

// ────────────────────────────────────────────────────────────────────
// Builder
// ────────────────────────────────────────────────────────────────────

export function buildAsoAnalystDailyTask(
  input: AsoAnalystDailyInput,
): AiTask<AsoAnalystDailyInput, AsoAnalystDailyOutput> {
  return {
    kind: "anomaly.explain",
    input,
    systemPrompt: SYSTEM_PROMPT,
    userPrompt: renderUserPrompt(input),
    outputSchema: AsoAnalystDailyOutput,
    jsonSchema: JSON_SCHEMA as unknown as Record<string, unknown>,
    taskName: "submit_daily_analyst_brief",
    taskDescription:
      "Return the senior ASO consultant's morning brief — headline, verdict, top-3 priorities, per-alarm interpretation, and opportunities.",
    maxOutputTokens: 3000,
    temperature: 0.3,
  };
}

// ────────────────────────────────────────────────────────────────────
// User-prompt rendering — keeps the prompt compact + deterministic
// ────────────────────────────────────────────────────────────────────

function renderUserPrompt(input: AsoAnalystDailyInput): string {
  const lines: string[] = [];
  lines.push(`# App`);
  lines.push(`Name:      ${input.appName}`);
  lines.push(`Bundle ID: ${input.bundleId}`);
  lines.push(`Platform:  ${input.platform}`);
  lines.push(`Primary locale: ${input.primaryLocale}`);
  if (input.primaryGenre) lines.push(`Genre:     ${input.primaryGenre}`);

  lines.push("");
  lines.push(`# Today's metrics (${input.metrics.date})`);
  lines.push(
    `Downloads today vs yesterday vs 7d-avg: ${fmtInt(input.metrics.downloadsToday)} / ${fmtInt(input.metrics.downloadsYesterday)} / ${fmtInt(input.metrics.downloads7dAvg)}`,
  );
  lines.push(
    `Impressions today vs yesterday: ${fmtInt(input.metrics.impressionsToday)} / ${fmtInt(input.metrics.impressionsYesterday)}`,
  );
  lines.push(
    `CVR % today vs yesterday vs 7d-avg: ${fmtRate(input.metrics.cvrToday)} / ${fmtRate(input.metrics.cvrYesterday)} / ${fmtRate(input.metrics.cvr7dAvg)}`,
  );
  lines.push(
    `Rating today vs yesterday: ${fmtRate(input.metrics.ratingToday)} / ${fmtRate(input.metrics.ratingYesterday)}`,
  );
  lines.push(`New low-star reviews today: ${input.metrics.newLowStarReviewsToday.toString()}`);

  if (input.keywordHighlights.length > 0) {
    lines.push("");
    lines.push(`# Material keyword moves (own + competitor-tagged)`);
    lines.push(`(keyword | territory | tags | rankYesterday → rankToday | bucketToday)`);
    for (const kw of input.keywordHighlights) {
      lines.push(
        `  ${kw.keyword} | ${kw.territory} | ${(kw.tags.length ? kw.tags.join(",") : "—")} | ${rk(kw.rankYesterday)} → ${rk(kw.rankToday)} | ${kw.bucketToday ?? "—"}`,
      );
    }
  }

  if (input.competitorHighlights.length > 0) {
    lines.push("");
    lines.push(`# Material competitor moves on OUR tracked keywords`);
    lines.push(`(competitor | keyword | their rank Y → T | our rank today)`);
    for (const c of input.competitorHighlights) {
      lines.push(
        `  ${c.competitorName} | ${c.keyword} | ${rk(c.rankYesterday)} → ${rk(c.rankToday)} | our: ${rk(c.ourRankToday)}`,
      );
    }
  }

  lines.push("");
  if (input.alarms.length === 0) {
    lines.push(`# Alarms`);
    lines.push(`(no alarms fired today — return calm verdict if metrics confirm baseline)`);
  } else {
    lines.push(`# Alarms fired today — interpret EVERY one`);
    for (const a of input.alarms) {
      lines.push("");
      lines.push(`## ${a.id} [${a.severity}] ${a.kind}`);
      lines.push(`Machine title:   ${a.title}`);
      lines.push(`Machine message: ${a.message}`);
      lines.push(`Payload: ${JSON.stringify(a.payload)}`);
    }
  }

  if (input.recentChanges && input.recentChanges.trim().length > 0) {
    lines.push("");
    lines.push(`# Recent changes the user made (probable-cause material)`);
    lines.push(input.recentChanges.trim());
  }

  // Adopted-vs-default summary — surfaces whether keyword swap
  // experiments are paying off. The analyst is expected to weave
  // this into the brief when the verdict is decisive (winning /
  // behind), and skip it when 'insufficient' or 'even'.
  if (input.adoptedPerformance) {
    const a = input.adoptedPerformance;
    lines.push("");
    lines.push(`# Adopted-vs-default keyword performance`);
    lines.push(
      `Adopted count: ${a.adoptedCount.toString()} | avg rank: ${a.adoptedAvgRank == null ? "—" : a.adoptedAvgRank.toFixed(1)}`,
    );
    lines.push(
      `Default count: ${a.defaultCount.toString()} | avg rank: ${a.defaultAvgRank == null ? "—" : a.defaultAvgRank.toFixed(1)}`,
    );
    lines.push(`Verdict: ${a.verdict}`);
    if (a.verdict === "winning") {
      lines.push(
        `(Acknowledge in the brief that the user's recent swaps are paying off.)`,
      );
    } else if (a.verdict === "behind") {
      lines.push(
        `(Acknowledge in the brief that the adopted keywords are underperforming the defaults — consider revising or reverting.)`,
      );
    }
  }

  lines.push("");
  lines.push(`# Your task`);
  lines.push(
    `Return the brief in the schema. Echo each alarm.id into alarmInterpretations[].alarmId — do not skip alarms.`,
  );
  return lines.join("\n");
}

/** Integer-style metric (downloads, impressions). */
function fmtInt(n: number | null): string {
  if (n == null) return "—";
  return Math.round(n).toString();
}

/** Rate-style metric (CVR %, star rating) — always 2 decimals so
 *  4.7 → "4.70" reads consistently next to 4.65 / 4.40. */
function fmtRate(n: number | null): string {
  if (n == null) return "—";
  return n.toFixed(2);
}

function rk(n: number | null): string {
  return n == null ? "off" : `#${n.toString()}`;
}
