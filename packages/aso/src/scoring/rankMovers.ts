/**
 * Rank Movers — pure summariser, NOT an alarm evaluator.
 *
 * Where the alarm engine fires only when a delta exceeds severity-
 * worthy thresholds (default ≥3 positions inside top-100, exits from
 * top-50, etc.), this module surfaces EVERY rank movement so the UI
 * can show "what changed today" at a glance — even when nothing
 * triggered an alarm.
 *
 * Two views the UI cares about:
 *   • per-app: a compact "today's climbers vs decliners" card
 *   • portfolio: "biggest movers across every app" strip
 *
 * Pure, deterministic, no DB — input is the same KeywordRankDelta[]
 * the alarm engine consumes, so we can compute both panels from the
 * AsoDailyCheck.keywordDeltas JSON column without re-querying signals.
 */
import type { KeywordRankDelta } from "./alarmEngine";

export type MoverDirection = "up" | "down" | "entered" | "exited";

export interface RankMover {
  trackedKeywordId: string;
  keyword: string;
  territory: string;
  tags: string[];
  /** Yesterday's rank — null = wasn't on list. */
  rankYesterday: number | null;
  /** Today's rank — null = fell off list. */
  rankToday: number | null;
  /** Positive = improved, negative = worsened. null when one side is
   *  off-list (an entered/exited event — magnitude is undefined). */
  delta: number | null;
  /** Magnitude used for sorting. Off-list moves get a synthetic high
   *  weight so champion-level exits/entries surface to the top. */
  magnitude: number;
  direction: MoverDirection;
}

export interface RankMoversSummary {
  movers: RankMover[];
  totals: {
    climbers: number;
    decliners: number;
    entered: number;
    exited: number;
    unchanged: number;
  };
}

/** Synthetic magnitude for off-list events so they sort sensibly
 *  next to numeric deltas. A top-3 keyword exiting is "worse" than
 *  a 15-position drop; a brand-new top-3 entry is "better" than a
 *  15-position climb. */
function offListMagnitude(rank: number): number {
  // Closer to #1 = bigger magnitude. Top-3 → ~70, top-10 → ~50,
  // top-50 → ~10. Above 50 doesn't get to the off-list evaluators
  // anyway (see KEYWORD_RANK_EXIT default threshold).
  return Math.max(1, 100 - rank * 2);
}

/**
 * Convert raw deltas into a UI-ready mover list. Sorted so the most
 * material movements (biggest magnitude) come first; ties broken by
 * direction (improvements ranked first) then by keyword name.
 *
 * Excludes:
 *   • rows where both rankToday and rankYesterday are null (no signal)
 *   • rows where both ranks match exactly (true zero-delta noise — but
 *     same-rank pairs ARE counted toward `unchanged` in `totals`).
 */
export function summariseRankMovers(deltas: KeywordRankDelta[]): RankMoversSummary {
  const movers: RankMover[] = [];
  const totals = { climbers: 0, decliners: 0, entered: 0, exited: 0, unchanged: 0 };

  for (const d of deltas) {
    const today = d.rankToday;
    const prev = d.rankYesterday;

    // Both unknown — irrelevant for the movers view.
    if (today == null && prev == null) continue;

    // Entered the list today.
    if (today != null && prev == null) {
      totals.entered += 1;
      movers.push({
        trackedKeywordId: d.trackedKeywordId,
        keyword: d.keyword,
        territory: d.territory,
        tags: d.tags,
        rankYesterday: null,
        rankToday: today,
        delta: null,
        magnitude: offListMagnitude(today),
        direction: "entered",
      });
      continue;
    }

    // Exited the list today.
    if (today == null && prev != null) {
      totals.exited += 1;
      movers.push({
        trackedKeywordId: d.trackedKeywordId,
        keyword: d.keyword,
        territory: d.territory,
        tags: d.tags,
        rankYesterday: prev,
        rankToday: null,
        delta: null,
        magnitude: offListMagnitude(prev),
        direction: "exited",
      });
      continue;
    }

    // Both ranked — compute numeric delta.
    if (today != null && prev != null) {
      if (today === prev) {
        totals.unchanged += 1;
        continue;
      }
      const delta = prev - today; // positive = improved
      const direction: MoverDirection = delta > 0 ? "up" : "down";
      if (delta > 0) totals.climbers += 1;
      else totals.decliners += 1;
      movers.push({
        trackedKeywordId: d.trackedKeywordId,
        keyword: d.keyword,
        territory: d.territory,
        tags: d.tags,
        rankYesterday: prev,
        rankToday: today,
        delta,
        magnitude: Math.abs(delta),
        direction,
      });
    }
  }

  movers.sort((a, b) => {
    if (b.magnitude !== a.magnitude) return b.magnitude - a.magnitude;
    // Tie-break: improvements + entries before regressions + exits.
    const orderOf = (m: RankMover): number =>
      m.direction === "entered" ? 0 : m.direction === "up" ? 1 : m.direction === "down" ? 2 : 3;
    const ord = orderOf(a) - orderOf(b);
    if (ord !== 0) return ord;
    return a.keyword.localeCompare(b.keyword);
  });

  return { movers, totals };
}

/**
 * Pick the top N climbers (best-direction movers). Used by the
 * compact UI panel to render two parallel columns.
 */
export function topClimbers(summary: RankMoversSummary, n: number): RankMover[] {
  return summary.movers
    .filter((m) => m.direction === "up" || m.direction === "entered")
    .slice(0, n);
}

/**
 * Pick the top N decliners — same idea, opposite direction.
 */
export function topDecliners(summary: RankMoversSummary, n: number): RankMover[] {
  return summary.movers
    .filter((m) => m.direction === "down" || m.direction === "exited")
    .slice(0, n);
}
