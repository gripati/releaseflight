/**
 * competitorDiff — pure function that compares two CompetitorSnapshot
 * payloads and emits one `CompetitorChangeEvent` per detected change.
 *
 * Used by the `aso.competitor-sync` worker: every nightly run the
 * fresh iTunes Lookup payload becomes the "current" snapshot, and we
 * diff it against the most recent prior snapshot in the same territory
 * to figure out what to write to AsoNotification.
 *
 * Design contract:
 *   • Pure — no side effects, no Date.now(), no I/O.
 *   • Stable ordering — the same input always returns events in the
 *     same order (worst-severity first, then alphabetical kind).
 *   • Conservative — micro-fluctuations (rating moved 0.01) don't
 *     fire. Apple recomputes the rolling average every poll, so a
 *     2-decimal stable threshold avoids noise notifications.
 *   • Severity-tagged — every event carries `severity: "info" |
 *     "warning" | "danger"`, mirroring the AsoNotification model so
 *     the consumer can write rows without translation.
 *
 * Severity policy:
 *   danger  → identity-shifting changes: name, subtitle, version,
 *             developer (very rare — only on a rights transfer).
 *   warning → listing edits: description, release notes, screenshots,
 *             price, content rating, primary genre.
 *   info    → ambient changes the operator cares about but don't
 *             demand action: rating drift, rating-count jumps, new
 *             languages, new minimum OS.
 */

/** The slice of CompetitorSnapshot fields the diff actually reads.
 *  Defined here (not imported from @prisma/client) so this module
 *  stays pure + framework-free + unit-testable. */
export interface CompetitorSnapshotInput {
  name: string | null;
  subtitle: string | null;
  description: string | null;
  releaseNotes: string | null;
  version: string | null;
  averageUserRating: number | null;
  userRatingCount: number | null;
  iphoneScreenshotUrls: string[];
  ipadScreenshotUrls: string[];
  sellerName: string | null;
  primaryGenre: string | null;
  genres: string[];
  contentAdvisoryRating: string | null;
  minimumOsVersion: string | null;
  languageCodes: string[];
  price: number | null;
  currency: string | null;
}

export type CompetitorChangeKind =
  | "NAME_CHANGED"
  | "SUBTITLE_CHANGED"
  | "DESCRIPTION_CHANGED"
  | "RELEASE_NOTES_CHANGED"
  | "VERSION_BUMPED"
  | "SCREENSHOTS_CHANGED"
  | "RATING_CHANGED"
  | "RATING_COUNT_JUMPED"
  | "PRICE_CHANGED"
  | "PRIMARY_GENRE_CHANGED"
  | "LANGUAGES_ADDED"
  | "LANGUAGES_REMOVED"
  | "MIN_OS_CHANGED"
  | "CONTENT_ADVISORY_CHANGED"
  | "SELLER_CHANGED";

export type CompetitorChangeSeverity = "info" | "warning" | "danger";

export interface CompetitorChangeEvent {
  kind: CompetitorChangeKind;
  severity: CompetitorChangeSeverity;
  /** One-line human-readable summary suitable for a notification
   *  title. Kept under 90 chars so it fits the bell drawer's row. */
  headline: string;
  /** Longer, optional explanation — surfaces in the notification
   *  body. May include before / after values, percentages, etc. */
  detail: string;
  /** Machine-readable payload for the notification's `payload` JSON
   *  column. Lets the UI render a diff side-by-side without re-
   *  parsing the headline string. */
  payload: Record<string, unknown>;
}

/** Tunable thresholds — exposed so tests and future tuning don't have
 *  to chase magic numbers through the function body. */
export interface DiffThresholds {
  /** Min |Δrating| (5-pt scale) before we fire RATING_CHANGED. */
  ratingDelta: number;
  /** Min |ΔratingCount / prevCount| (fractional) before
   *  RATING_COUNT_JUMPED. e.g. 0.10 = 10% relative growth. */
  ratingCountJumpPct: number;
  /** Description / release-notes Jaccard distance threshold before
   *  we fire CHANGED. 0.05 = ≥5% token churn. */
  textChangeMinDistance: number;
}

export const DEFAULT_DIFF_THRESHOLDS: DiffThresholds = {
  ratingDelta: 0.05,
  ratingCountJumpPct: 0.05,
  textChangeMinDistance: 0.03,
};

/** Severity precedence used to sort events most-important-first. */
const SEVERITY_RANK: Record<CompetitorChangeSeverity, number> = {
  danger: 0,
  warning: 1,
  info: 2,
};

// ──────────────────────────────────────────────────────────────────────
// Public entry
// ──────────────────────────────────────────────────────────────────────

/**
 * Compare a previous and current competitor snapshot. Returns the
 * detected change events sorted danger → warning → info, then
 * alphabetical by kind for stability across runs.
 */
export function diffCompetitorSnapshots(
  prev: CompetitorSnapshotInput,
  curr: CompetitorSnapshotInput,
  thresholds: DiffThresholds = DEFAULT_DIFF_THRESHOLDS,
): CompetitorChangeEvent[] {
  const events: CompetitorChangeEvent[] = [];

  // ── Identity-shifting (danger) ────────────────────────────────────
  if (notEqualNullable(prev.name, curr.name)) {
    events.push({
      kind: "NAME_CHANGED",
      severity: "danger",
      headline: `Name changed to "${truncate(curr.name ?? "—", 60)}"`,
      detail: `Was "${truncate(prev.name ?? "—", 80)}", now "${truncate(curr.name ?? "—", 80)}".`,
      payload: { previous: prev.name, current: curr.name },
    });
  }
  if (notEqualNullable(prev.subtitle, curr.subtitle)) {
    events.push({
      kind: "SUBTITLE_CHANGED",
      severity: "danger",
      headline: `Subtitle changed to "${truncate(curr.subtitle ?? "—", 60)}"`,
      detail: `Was "${truncate(prev.subtitle ?? "—", 80)}", now "${truncate(curr.subtitle ?? "—", 80)}".`,
      payload: { previous: prev.subtitle, current: curr.subtitle },
    });
  }
  if (
    notEqualNullable(prev.version, curr.version) &&
    curr.version != null &&
    prev.version != null
  ) {
    // We only flag a true version bump, not the initial seed. The
    // first snapshot has no prev.version, which would otherwise fire
    // every nightly run on the first day.
    events.push({
      kind: "VERSION_BUMPED",
      severity: "danger",
      headline: `Released version ${curr.version}`,
      detail: `New version ${curr.version} (was ${prev.version}). Compare release notes to see what shipped.`,
      payload: { previous: prev.version, current: curr.version },
    });
  }
  if (notEqualNullable(prev.sellerName, curr.sellerName)) {
    events.push({
      kind: "SELLER_CHANGED",
      severity: "danger",
      headline: `Publisher changed to ${curr.sellerName ?? "—"}`,
      detail: `Was "${prev.sellerName ?? "—"}", now "${curr.sellerName ?? "—"}". Likely an ownership transfer.`,
      payload: { previous: prev.sellerName, current: curr.sellerName },
    });
  }

  // ── Listing edits (warning) ───────────────────────────────────────
  const descDistance = textJaccardDistance(prev.description, curr.description);
  if (descDistance >= thresholds.textChangeMinDistance) {
    events.push({
      kind: "DESCRIPTION_CHANGED",
      severity: "warning",
      headline: `Description rewritten (${pct(descDistance)} text churn)`,
      detail: `${pct(descDistance)} of tokens differ vs. the prior snapshot.`,
      payload: {
        distance: round(descDistance, 3),
        previous: prev.description,
        current: curr.description,
      },
    });
  }
  const notesDistance = textJaccardDistance(prev.releaseNotes, curr.releaseNotes);
  if (notesDistance >= thresholds.textChangeMinDistance) {
    events.push({
      kind: "RELEASE_NOTES_CHANGED",
      severity: "warning",
      headline: `Release notes updated`,
      detail: `${pct(notesDistance)} of tokens differ — often signals a new version.`,
      payload: {
        distance: round(notesDistance, 3),
        previous: prev.releaseNotes,
        current: curr.releaseNotes,
      },
    });
  }

  const screenshotDiff = compareScreenshotSets(
    prev.iphoneScreenshotUrls,
    curr.iphoneScreenshotUrls,
  );
  const ipadScreenshotDiff = compareScreenshotSets(
    prev.ipadScreenshotUrls,
    curr.ipadScreenshotUrls,
  );
  if (screenshotDiff.changed || ipadScreenshotDiff.changed) {
    const added = screenshotDiff.added + ipadScreenshotDiff.added;
    const removed = screenshotDiff.removed + ipadScreenshotDiff.removed;
    const reordered =
      screenshotDiff.reorderedOnly || ipadScreenshotDiff.reorderedOnly;
    let headline: string;
    if (added > 0 && removed > 0) {
      headline = `Screenshots swapped (+${added.toString()}, -${removed.toString()})`;
    } else if (added > 0) {
      headline = `Added ${added.toString()} screenshot${added === 1 ? "" : "s"}`;
    } else if (removed > 0) {
      headline = `Removed ${removed.toString()} screenshot${removed === 1 ? "" : "s"}`;
    } else if (reordered) {
      headline = `Screenshots reordered`;
    } else {
      headline = `Screenshots changed`;
    }
    events.push({
      kind: "SCREENSHOTS_CHANGED",
      severity: "warning",
      headline,
      detail: [
        screenshotDiff.changed
          ? `iPhone: +${screenshotDiff.added.toString()}, -${screenshotDiff.removed.toString()}${screenshotDiff.reorderedOnly ? " (reordered)" : ""}`
          : null,
        ipadScreenshotDiff.changed
          ? `iPad: +${ipadScreenshotDiff.added.toString()}, -${ipadScreenshotDiff.removed.toString()}${ipadScreenshotDiff.reorderedOnly ? " (reordered)" : ""}`
          : null,
      ]
        .filter(Boolean)
        .join(" · "),
      payload: {
        iphone: {
          previous: prev.iphoneScreenshotUrls,
          current: curr.iphoneScreenshotUrls,
          added: screenshotDiff.added,
          removed: screenshotDiff.removed,
        },
        ipad: {
          previous: prev.ipadScreenshotUrls,
          current: curr.ipadScreenshotUrls,
          added: ipadScreenshotDiff.added,
          removed: ipadScreenshotDiff.removed,
        },
      },
    });
  }

  if (priceChanged(prev, curr)) {
    events.push({
      kind: "PRICE_CHANGED",
      severity: "warning",
      headline: `Price changed: ${formatPrice(prev)} → ${formatPrice(curr)}`,
      detail: `Was ${formatPrice(prev)}, now ${formatPrice(curr)}.`,
      payload: {
        previous: { price: prev.price, currency: prev.currency },
        current: { price: curr.price, currency: curr.currency },
      },
    });
  }

  if (notEqualNullable(prev.primaryGenre, curr.primaryGenre)) {
    events.push({
      kind: "PRIMARY_GENRE_CHANGED",
      severity: "warning",
      headline: `Primary genre changed to ${curr.primaryGenre ?? "—"}`,
      detail: `Was "${prev.primaryGenre ?? "—"}", now "${curr.primaryGenre ?? "—"}".`,
      payload: {
        previous: prev.primaryGenre,
        current: curr.primaryGenre,
      },
    });
  }

  // ── Ambient changes (info) ────────────────────────────────────────
  if (
    prev.averageUserRating != null &&
    curr.averageUserRating != null &&
    Math.abs(curr.averageUserRating - prev.averageUserRating) >= thresholds.ratingDelta
  ) {
    const delta = curr.averageUserRating - prev.averageUserRating;
    const arrow = delta > 0 ? "↑" : "↓";
    events.push({
      kind: "RATING_CHANGED",
      severity: "info",
      headline: `Rating ${arrow} ${Math.abs(delta).toFixed(2)} to ${curr.averageUserRating.toFixed(2)}`,
      detail: `Was ${prev.averageUserRating.toFixed(2)}, now ${curr.averageUserRating.toFixed(2)} (Δ ${delta > 0 ? "+" : ""}${delta.toFixed(2)}).`,
      payload: {
        previous: prev.averageUserRating,
        current: curr.averageUserRating,
        delta,
      },
    });
  }

  if (
    prev.userRatingCount != null &&
    curr.userRatingCount != null &&
    prev.userRatingCount > 0
  ) {
    const delta = curr.userRatingCount - prev.userRatingCount;
    const ratio = Math.abs(delta) / prev.userRatingCount;
    if (ratio >= thresholds.ratingCountJumpPct && Math.abs(delta) >= 50) {
      // Floor at 50 reviews — avoids firing for tiny apps where 10
      // new reviews is "10% growth" but doesn't really signal much.
      const arrow = delta > 0 ? "↑" : "↓";
      events.push({
        kind: "RATING_COUNT_JUMPED",
        severity: "info",
        headline: `Review count ${arrow} ${formatCompactInt(Math.abs(delta))} (${pct(ratio)})`,
        detail: `Was ${formatCompactInt(prev.userRatingCount)}, now ${formatCompactInt(curr.userRatingCount)}.`,
        payload: {
          previous: prev.userRatingCount,
          current: curr.userRatingCount,
          delta,
        },
      });
    }
  }

  const langsDiff = compareLanguageSets(prev.languageCodes, curr.languageCodes);
  if (langsDiff.added.length > 0) {
    events.push({
      kind: "LANGUAGES_ADDED",
      severity: "info",
      headline: `Added ${langsDiff.added.length.toString()} language${langsDiff.added.length === 1 ? "" : "s"}`,
      detail: `New: ${langsDiff.added.join(", ")}.`,
      payload: { added: langsDiff.added, previous: prev.languageCodes, current: curr.languageCodes },
    });
  }
  if (langsDiff.removed.length > 0) {
    events.push({
      kind: "LANGUAGES_REMOVED",
      severity: "info",
      headline: `Dropped ${langsDiff.removed.length.toString()} language${langsDiff.removed.length === 1 ? "" : "s"}`,
      detail: `Removed: ${langsDiff.removed.join(", ")}.`,
      payload: { removed: langsDiff.removed, previous: prev.languageCodes, current: curr.languageCodes },
    });
  }

  if (notEqualNullable(prev.minimumOsVersion, curr.minimumOsVersion)) {
    events.push({
      kind: "MIN_OS_CHANGED",
      severity: "info",
      headline: `Minimum OS now ${curr.minimumOsVersion ?? "—"}`,
      detail: `Was ${prev.minimumOsVersion ?? "—"}, now ${curr.minimumOsVersion ?? "—"}.`,
      payload: {
        previous: prev.minimumOsVersion,
        current: curr.minimumOsVersion,
      },
    });
  }

  if (notEqualNullable(prev.contentAdvisoryRating, curr.contentAdvisoryRating)) {
    events.push({
      kind: "CONTENT_ADVISORY_CHANGED",
      severity: "info",
      headline: `Content advisory now ${curr.contentAdvisoryRating ?? "—"}`,
      detail: `Was ${prev.contentAdvisoryRating ?? "—"}, now ${curr.contentAdvisoryRating ?? "—"}.`,
      payload: {
        previous: prev.contentAdvisoryRating,
        current: curr.contentAdvisoryRating,
      },
    });
  }

  // Stable sort: severity rank first, then kind alphabetical.
  events.sort((a, b) => {
    const r = SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity];
    if (r !== 0) return r;
    return a.kind.localeCompare(b.kind);
  });

  return events;
}

// ──────────────────────────────────────────────────────────────────────
// Comparators + utilities
// ──────────────────────────────────────────────────────────────────────

function notEqualNullable(a: string | null, b: string | null): boolean {
  // Treat null and "" as identical — Apple sometimes flips between
  // omitting a field and returning an empty string.
  const na = a ?? "";
  const nb = b ?? "";
  return na.trim() !== nb.trim();
}

/** Token-level Jaccard distance: 1 - (|A ∩ B| / |A ∪ B|). Returns
 *  values in [0, 1] where 0 = identical, 1 = no overlap. Operates on
 *  whitespace-split lowercased tokens (no stemming — this is for
 *  change detection, not search). */
function textJaccardDistance(a: string | null, b: string | null): number {
  const sa = new Set(tokenize(a));
  const sb = new Set(tokenize(b));
  if (sa.size === 0 && sb.size === 0) return 0;
  let intersection = 0;
  for (const t of sa) if (sb.has(t)) intersection++;
  const union = sa.size + sb.size - intersection;
  if (union === 0) return 0;
  return 1 - intersection / union;
}

function tokenize(s: string | null): string[] {
  if (!s) return [];
  return s
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, " ")
    .split(/\s+/)
    .filter((t) => t.length >= 2);
}

interface ScreenshotDiffSummary {
  changed: boolean;
  added: number;
  removed: number;
  /** True when the two arrays are the same set but a different order. */
  reorderedOnly: boolean;
}

function compareScreenshotSets(
  prev: string[],
  curr: string[],
): ScreenshotDiffSummary {
  // Apple's CDN URLs include a content hash, so the URL changes
  // whenever the underlying image changes — set comparison is enough.
  const setPrev = new Set(prev);
  const setCurr = new Set(curr);
  let added = 0;
  let removed = 0;
  for (const u of setCurr) if (!setPrev.has(u)) added++;
  for (const u of setPrev) if (!setCurr.has(u)) removed++;
  if (added === 0 && removed === 0) {
    // Same set — check ordering.
    const reorderedOnly = prev.length === curr.length &&
      prev.some((u, i) => u !== curr[i]);
    return { changed: reorderedOnly, added: 0, removed: 0, reorderedOnly };
  }
  return { changed: true, added, removed, reorderedOnly: false };
}

function compareLanguageSets(
  prev: string[],
  curr: string[],
): { added: string[]; removed: string[] } {
  const setPrev = new Set(prev);
  const setCurr = new Set(curr);
  const added: string[] = [];
  const removed: string[] = [];
  for (const c of setCurr) if (!setPrev.has(c)) added.push(c);
  for (const c of setPrev) if (!setCurr.has(c)) removed.push(c);
  added.sort();
  removed.sort();
  return { added, removed };
}

function priceChanged(
  prev: CompetitorSnapshotInput,
  curr: CompetitorSnapshotInput,
): boolean {
  if (prev.price == null && curr.price == null) return false;
  if (prev.price == null || curr.price == null) return true;
  // Treat micro-jitter (rounding to local currency conventions) as no-op.
  return Math.abs(curr.price - prev.price) > 0.005;
}

function formatPrice(s: CompetitorSnapshotInput): string {
  if (s.price == null || s.price === 0) return "Free";
  const currency = s.currency ?? "";
  return `${s.price.toFixed(2)} ${currency}`.trim();
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return `${s.slice(0, n - 1)}…`;
}

function round(n: number, dp: number): number {
  const m = 10 ** dp;
  return Math.round(n * m) / m;
}

function pct(ratio: number): string {
  return `${Math.round(ratio * 100).toString()}%`;
}

function formatCompactInt(n: number): string {
  const abs = Math.abs(n);
  if (abs < 1_000) return n.toString();
  if (abs < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}K`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}
