/**
 * Daily-check orchestrator — turns a per-app snapshot into:
 *   1. AlarmEvent[]      from `evaluateAllAlarms`
 *   2. AnalystReport     from the AI analyst (optional — falls back to
 *                        machine-generated copy when AI unavailable)
 *   3. NotificationRecord[]  ready for DB persistence
 *
 * KEPT PURE on purpose — the API route / worker is responsible for
 * fetching data + persisting results, but the orchestration logic
 * (alarm dedup, severity rollup, analyst-result merging) lives here
 * so it's deterministically testable.
 */
import type { AlarmEvent, AlarmEvaluationInput } from "./alarmEngine";
import { evaluateAllAlarms } from "./alarmEngine";
import type {
  AsoAnalystDailyInput,
  AsoAnalystDailyOutput,
} from "../ai/prompts/asoAnalystDaily";

/** Final shape persisted to AsoNotification. */
export interface NotificationRecord {
  /** Stable per-day key — used for idempotency upserts. */
  dedupKey: string;
  alarmKey: string;
  severity: "info" | "warning" | "danger";
  title: string;
  /** Human-language message — analyst version preferred, machine version fallback. */
  message: string;
  payload: Record<string, unknown>;
  trackedKeywordId: string | null;
  competitorId: string | null;
  /** ASO analyst's interpretation when AI ran. Stored separately so
   *  the UI can show "raw signal" + "consultant voice" side by side. */
  agentInterpretation: string | null;
  agentProbableCause: string | null;
  agentNextAction: string | null;
  agentConfidence: number | null;
}

export interface DailyCheckResult {
  /** Raw alarm events from the engine — for the dashboard's "today's
   *  signals" feed even if AI is down. */
  events: AlarmEvent[];
  /** Notifications ready to upsert. */
  notifications: NotificationRecord[];
  /** Full analyst output (or null when AI was skipped/failed). */
  analystReport: AsoAnalystDailyOutput | null;
  /** Roll-up severity — drives the bell badge color. */
  overallSeverity: "info" | "warning" | "danger" | "calm";
  /** Counts per severity. */
  counts: { danger: number; warning: number; info: number };
}

/** Input the orchestrator needs to do its job. */
export interface DailyCheckInput {
  appId: string;
  date: string; // YYYY-MM-DD
  alarmInput: AlarmEvaluationInput;
  /** Pre-built analyst input — everything except `alarms`, which is
   *  filled in by the orchestrator from the engine's output. */
  analystInputBase: Omit<AsoAnalystDailyInput, "alarms">;
  /** Optional analyst caller — pass null/undefined to skip AI. */
  runAnalyst?: (input: AsoAnalystDailyInput) => Promise<AsoAnalystDailyOutput | null>;
}

export async function runDailyCheck(input: DailyCheckInput): Promise<DailyCheckResult> {
  const events = evaluateAllAlarms(input.alarmInput);

  let analystReport: AsoAnalystDailyOutput | null = null;
  if (events.length > 0 && input.runAnalyst) {
    const analystInput: AsoAnalystDailyInput = {
      ...input.analystInputBase,
      alarms: events.map((e, idx) => ({
        id: `${input.date}#${idx.toString()}`,
        kind: e.kind,
        severity: e.severity,
        title: e.title,
        message: e.message,
        payload: e.payload,
        trackedKeywordId: e.trackedKeywordId,
        competitorId: e.competitorId,
      })),
    };
    try {
      analystReport = await input.runAnalyst(analystInput);
    } catch {
      // Swallow AI errors — the daily check should still produce
      // machine-generated notifications even when the analyst is down.
      analystReport = null;
    }
  }

  const interpretationsByAlarmId = new Map<
    string,
    { interpretation: string; probableCause: string; nextAction: string; confidence: number }
  >();
  if (analystReport) {
    for (const a of analystReport.alarmInterpretations) {
      interpretationsByAlarmId.set(a.alarmId, {
        interpretation: a.interpretation,
        probableCause: a.probableCause,
        nextAction: a.nextAction,
        confidence: a.confidence,
      });
    }
  }

  const notifications: NotificationRecord[] = events.map((e, idx) => {
    const alarmKey = `${input.date}#${idx.toString()}`;
    const ai = interpretationsByAlarmId.get(alarmKey);
    return {
      dedupKey: dedupKeyFor(input.appId, input.date, e),
      alarmKey,
      severity: e.severity,
      title: e.title,
      message: ai?.interpretation ?? e.message,
      payload: e.payload,
      trackedKeywordId: e.trackedKeywordId ?? null,
      competitorId: e.competitorId ?? null,
      agentInterpretation: ai?.interpretation ?? null,
      agentProbableCause: ai?.probableCause ?? null,
      agentNextAction: ai?.nextAction ?? null,
      agentConfidence: ai?.confidence ?? null,
    };
  });

  const counts = {
    danger: events.filter((e) => e.severity === "danger").length,
    warning: events.filter((e) => e.severity === "warning").length,
    info: events.filter((e) => e.severity === "info").length,
  };
  const overallSeverity: DailyCheckResult["overallSeverity"] =
    counts.danger > 0
      ? "danger"
      : counts.warning > 0
        ? "warning"
        : counts.info > 0
          ? "info"
          : "calm";

  return {
    events,
    notifications,
    analystReport,
    overallSeverity,
    counts,
  };
}

/**
 * Stable per-day key. Same input → same key → idempotent upsert.
 * Includes the alarm kind + identifying ids so re-running the same
 * day doesn't duplicate notifications, but a TRULY new alarm on the
 * same day (e.g. a different keyword) still creates its own row.
 */
function dedupKeyFor(appId: string, date: string, e: AlarmEvent): string {
  const target =
    e.trackedKeywordId ?? e.competitorId ?? JSON.stringify(e.payload).slice(0, 40);
  return `${appId}|${date}|${e.kind}|${target}`;
}
